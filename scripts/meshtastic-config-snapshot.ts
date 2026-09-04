#!/usr/bin/env -S npx tsx
/**
 * Capture and compare Meshtastic TCP configuration handshakes.
 *
 * The capture deliberately uses the same framed TCP request for a physical
 * node and MeshMonitor's Virtual Node. Secrets are replaced by a digest so
 * equality can be checked without writing credentials to disk.
 *
 * Examples:
 *   npx tsx scripts/meshtastic-config-snapshot.ts capture \
 *     --endpoint 192.168.1.20:4404 --label virtual --output /tmp/virtual.json
 *   # Firmware's config-only refresh (intentionally excludes the remote DB):
 *   npx tsx scripts/meshtastic-config-snapshot.ts capture \
 *     --endpoint 192.168.1.20:4404 --label virtual-config-only \
 *     --config-id 69420 --output /tmp/virtual-config-only.json
 *   npx tsx scripts/meshtastic-config-snapshot.ts compare \
 *     --left /tmp/real.json --right /tmp/virtual.json
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import process from 'node:process';
import { getProtobufRoot, loadProtobufDefinitions } from '../src/server/protobufLoader.js';

const START = Buffer.from([0x94, 0xc3]);
const MAX_FRAME_SIZE = 512;
const SECRET_FIELD = /(?:^|_)(?:psk|password|privateKey|publicKey|adminKey|secret|token)$/i;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface CapturedMessage {
  index: number;
  type: string;
  value: Record<string, JsonValue>;
}

interface Snapshot {
  formatVersion: 1;
  label: string;
  endpoint: string;
  capturedAt: string;
  durationMs: number;
  requestConfigId: number;
  responseConfigId: number | null;
  complete: boolean;
  error?: string;
  counts: Record<string, number>;
  sequence: string[];
  nodes: Array<{
    num: number | null;
    id: string | null;
    longName: string | null;
    shortName: string | null;
  }>;
  messages: CapturedMessage[];
}

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage:');
  console.error('  capture --endpoint HOST:PORT --label NAME --output FILE [--timeout-ms 30000] [--config-id ID]');
  console.error('  compare --left REAL.json --right VIRTUAL.json [--output DIFF.json]');
  process.exit(2);
}

function parseArgs(argv: string[]): { command: string; options: Map<string, string> } {
  const command = argv[0];
  if (!command) usage();
  const options = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) usage(`Invalid argument near ${key ?? '(end)'}`);
    options.set(key.slice(2), value);
  }
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) usage(`Missing --${name}`);
  return value;
}

function parseEndpoint(endpoint: string): { host: string; port: number } {
  const separator = endpoint.lastIndexOf(':');
  if (separator < 1) usage(`Invalid endpoint: ${endpoint}`);
  const host = endpoint.slice(0, separator);
  const port = Number(endpoint.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) usage(`Invalid endpoint: ${endpoint}`);
  return { host, port };
}

function frame(payload: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from([START[0], START[1], (payload.length >>> 8) & 0xff, payload.length & 0xff]),
    Buffer.from(payload),
  ]);
}

function digest(value: unknown): string {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
}

function redact(value: unknown, key = ''): JsonValue {
  if (SECRET_FIELD.test(key)) return `<redacted:${digest(value)}>`;
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return String(value);
}

function messageType(value: Record<string, unknown>): string {
  const known = [
    'myInfo', 'nodeInfo', 'metadata', 'channel', 'config', 'moduleConfig',
    'configCompleteId', 'packet', 'queueStatus', 'rebooted', 'logRecord',
    'mqttClientProxyMessage', 'clientNotification', 'fileInfo',
    'deviceuiConfig', 'regionPresets',
  ];
  return known.find((field) => value[field] !== undefined && value[field] !== null) ?? 'unknown';
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

async function capture(options: Map<string, string>): Promise<void> {
  const endpoint = required(options, 'endpoint');
  const label = required(options, 'label');
  const output = required(options, 'output');
  const timeoutMs = Number(options.get('timeout-ms') ?? 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) usage('--timeout-ms must be at least 1000');
  const { host, port } = parseEndpoint(endpoint);

  await loadProtobufDefinitions();
  const root = getProtobufRoot();
  if (!root) throw new Error('Meshtastic protobuf definitions did not load');
  const ToRadio = root.lookupType('meshtastic.ToRadio');
  const FromRadio = root.lookupType('meshtastic.FromRadio');
  // Avoid firmware-reserved 69420/69421 and zero by default. A fresh ID also
  // avoids the Virtual Node's duplicate-config cooldown when captures repeat.
  const requestedId = options.has('config-id') ? Number(options.get('config-id')) : randomBytes(4).readUInt32LE(0);
  if (!Number.isInteger(requestedId) || requestedId < 1 || requestedId > 0xffffffff) {
    usage('--config-id must be an unsigned 32-bit integer greater than zero');
  }
  const requestConfigId = requestedId >>> 0;
  const request = ToRadio.encode(ToRadio.create({ wantConfigId: requestConfigId })).finish();

  const started = Date.now();
  const messages: CapturedMessage[] = [];
  let responseConfigId: number | null = null;
  let buffer = Buffer.alloc(0);
  let captureError: Error | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error(`Timed out after ${timeoutMs}ms waiting for configCompleteId (received ${messages.length} frames)`));
      }, timeoutMs);

      socket.once('error', (error) => finish(error));
      socket.once('close', () => {
        if (!settled) finish(new Error(`Connection closed before config completed (received ${messages.length} frames)`));
      });
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const start = buffer.indexOf(START);
          if (start < 0) {
            buffer = buffer.subarray(Math.max(0, buffer.length - 1));
            break;
          }
          if (start > 0) buffer = buffer.subarray(start);
          if (buffer.length < 4) break;
          const length = buffer.readUInt16BE(2);
          if (length > MAX_FRAME_SIZE) {
            buffer = buffer.subarray(1);
            continue;
          }
          if (buffer.length < length + 4) break;
          const payload = buffer.subarray(4, length + 4);
          buffer = buffer.subarray(length + 4);
          try {
            const decoded = FromRadio.decode(payload);
            const object = FromRadio.toObject(decoded, {
              longs: String,
              enums: String,
              bytes: String,
              defaults: false,
              oneofs: true,
            }) as Record<string, unknown>;
            const type = messageType(object);
            messages.push({ index: messages.length, type, value: redact(object) as Record<string, JsonValue> });
            if (messages.length % 100 === 0) console.error(`Received ${messages.length} frames...`);
            if (type === 'configCompleteId') {
              responseConfigId = Number(object.configCompleteId) >>> 0;
              finish();
              return;
            }
          } catch (error) {
            finish(new Error(`Could not decode FromRadio frame ${messages.length}: ${(error as Error).message}`));
            return;
          }
        }
      });
      socket.connect(port, host, () => socket.write(frame(request)));
    });
  } catch (error) {
    captureError = error as Error;
  }

  const counts: Record<string, number> = {};
  for (const message of messages) counts[message.type] = (counts[message.type] ?? 0) + 1;
  const nodes = messages
    .filter((message) => message.type === 'nodeInfo')
    .map((message) => {
      const node = message.value.nodeInfo as Record<string, JsonValue>;
      const user = (node.user ?? {}) as Record<string, JsonValue>;
      return {
        num: node.num == null ? null : Number(node.num),
        id: typeof user.id === 'string' ? user.id : null,
        longName: typeof user.longName === 'string' ? user.longName : null,
        shortName: typeof user.shortName === 'string' ? user.shortName : null,
      };
    });
  const snapshot: Snapshot = {
    formatVersion: 1,
    label,
    endpoint,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    requestConfigId,
    responseConfigId,
    complete: responseConfigId === requestConfigId,
    ...(captureError ? { error: captureError.message } : {}),
    counts,
    sequence: messages.map((message) => message.type),
    nodes,
    messages,
  };
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ output, endpoint, complete: snapshot.complete, error: snapshot.error, durationMs: snapshot.durationMs, counts, nodes: nodes.length }, null, 2));
  if (captureError) process.exitCode = 1;
}

function keyedMessages(snapshot: Snapshot): Map<string, CapturedMessage> {
  const result = new Map<string, CapturedMessage>();
  const occurrence = new Map<string, number>();
  for (const message of snapshot.messages) {
    let identity = message.type;
    if (message.type === 'nodeInfo') {
      const node = message.value.nodeInfo as Record<string, JsonValue>;
      identity += `:${String(node.num ?? 'unknown')}`;
    } else if (message.type === 'channel') {
      const channel = message.value.channel as Record<string, JsonValue>;
      // Protobuf omits the default numeric value, so a missing index is slot 0.
      identity += `:${String(channel.index ?? 0)}`;
    } else if (message.type === 'config' || message.type === 'moduleConfig') {
      const body = message.value[message.type] as Record<string, JsonValue>;
      identity += `:${String(body?.payloadVariant ?? Object.keys(body ?? {})[0] ?? 'unknown')}`;
    } else {
      const number = occurrence.get(identity) ?? 0;
      occurrence.set(identity, number + 1);
      identity += `:${number}`;
    }
    result.set(identity, message);
  }
  return result;
}

async function compare(options: Map<string, string>): Promise<void> {
  const leftPath = required(options, 'left');
  const rightPath = required(options, 'right');
  const left = JSON.parse(await readFile(leftPath, 'utf8')) as Snapshot;
  const right = JSON.parse(await readFile(rightPath, 'utf8')) as Snapshot;
  const leftMessages = keyedMessages(left);
  const rightMessages = keyedMessages(right);
  const keys = [...new Set([...leftMessages.keys(), ...rightMessages.keys()])].sort();
  const onlyLeft = keys.filter((key) => leftMessages.has(key) && !rightMessages.has(key));
  const onlyRight = keys.filter((key) => !leftMessages.has(key) && rightMessages.has(key));
  const changed = keys
    .filter((key) => leftMessages.has(key) && rightMessages.has(key))
    .filter((key) => stableJson(leftMessages.get(key)!.value) !== stableJson(rightMessages.get(key)!.value))
    .map((key) => ({ key, left: leftMessages.get(key)!.value, right: rightMessages.get(key)!.value }));

  const leftNodes = new Map(left.nodes.map((node) => [String(node.num), node]));
  const rightNodes = new Map(right.nodes.map((node) => [String(node.num), node]));
  const nodeIds = [...new Set([...leftNodes.keys(), ...rightNodes.keys()])].sort();
  const nodeNameDifferences = nodeIds.flatMap((num) => {
    const a = leftNodes.get(num);
    const b = rightNodes.get(num);
    if (!a || !b || a.id !== b.id || a.longName !== b.longName || a.shortName !== b.shortName) {
      return [{ num, left: a ?? null, right: b ?? null }];
    }
    return [];
  });
  const report = {
    left: { label: left.label, endpoint: left.endpoint, counts: left.counts, nodes: left.nodes.length },
    right: { label: right.label, endpoint: right.endpoint, counts: right.counts, nodes: right.nodes.length },
    sequenceEqual: stableJson(left.sequence) === stableJson(right.sequence),
    onlyLeft,
    onlyRight,
    changedKeys: changed.map(({ key }) => key),
    nodeNameDifferences,
    changed,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = options.get('output');
  if (output) await writeFile(output, serialized, { mode: 0o600 });
  console.log(serialized.trimEnd());
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === 'capture') await capture(options);
else if (command === 'compare') await compare(options);
else usage(`Unknown command: ${command}`);
