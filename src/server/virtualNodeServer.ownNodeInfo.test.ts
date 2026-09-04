import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getNodeMock,
  getActiveNodesMock,
  createMyNodeInfoMock,
  createNodeInfoMock,
  rewriteMetadataMock,
  createConfigCompleteMock,
} = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
  getActiveNodesMock: vi.fn().mockResolvedValue([]),
  createMyNodeInfoMock: vi.fn().mockResolvedValue(new Uint8Array([1])),
  createNodeInfoMock: vi.fn().mockResolvedValue(new Uint8Array([2])),
  rewriteMetadataMock: vi.fn().mockResolvedValue(new Uint8Array([3])),
  createConfigCompleteMock: vi.fn().mockResolvedValue(new Uint8Array([6])),
}));

vi.mock('../services/database.js', () => {
  const shared = {
    nodes: { getNode: getNodeMock, getActiveNodes: getActiveNodesMock },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn().mockResolvedValue('24'),
    },
    waitForReady: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    createMyNodeInfo: createMyNodeInfoMock,
    createNodeInfo: createNodeInfoMock,
    rewriteMetadataFirmwareVersion: rewriteMetadataMock,
    createConfigComplete: createConfigCompleteMock,
  },
}));

vi.mock('./protobufService.js', () => ({ default: {} }));

import { VirtualNodeServer } from './virtualNodeServer.js';

describe('VirtualNodeServer OwnNodeInfo handshake slot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNodeMock.mockResolvedValue({
      nodeNum: 0x11223344,
      nodeId: '!11223344',
      longName: 'The local node',
      shortName: 'LOCAL',
      hwModel: 1,
    });
  });

  it('sends OwnNodeInfo directly after MyNodeInfo for a config-only request', async () => {
    const manager = {
      sourceId: 'source-a',
      isInitConfigCaptureComplete: () => true,
      getLocalNodeInfo: () => ({
        nodeNum: 0x11223344,
        nodeId: '!11223344',
        longName: 'The local node',
        shortName: 'LOCAL',
      }),
      getCachedInitConfig: () => [
        { type: 'metadata', data: new Uint8Array([30]) },
        { type: 'config', data: new Uint8Array([4]) },
        { type: 'moduleConfig', data: new Uint8Array([5]) },
      ],
      getActualDeviceConfig: () => null,
    } as any;
    const server = new VirtualNodeServer({ port: 0, meshtasticManager: manager });
    const writes: number[] = [];
    (server as any).clients.set('client-1', {
      socket: { destroyed: false, writable: true },
      id: 'client-1',
      buffer: Buffer.alloc(0),
      connectedAt: new Date(),
      lastActivity: new Date(),
    });
    (server as any).sendToClient = vi.fn(async (_clientId: string, data: Uint8Array) => {
      writes.push(data[0]);
    });

    await (server as any).sendInitialConfig('client-1', 69420);

    expect(writes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(createNodeInfoMock).toHaveBeenCalledWith(expect.objectContaining({
      nodeNum: 0x11223344,
      user: expect.objectContaining({ longName: 'The local node', shortName: 'LOCAL' }),
    }));
    expect(getActiveNodesMock).not.toHaveBeenCalled();
  });
});
