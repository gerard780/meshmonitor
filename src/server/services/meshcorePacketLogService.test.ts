import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { settings, meshcore } = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  meshcore: {
    deletePacketsOlderThan: vi.fn(async () => 0),
    getPacketLogSourceIds: vi.fn(async () => ['source-a']),
    trimPacketsToCount: vi.fn(async () => 0),
    insertPacket: vi.fn(async () => undefined),
    getPackets: vi.fn(async () => []),
    getPacketCount: vi.fn(async () => 0),
    deleteAllPackets: vi.fn(async () => 0),
  },
}));

vi.mock('../../services/database.js', () => ({
  default: {
    getSettingAsync: vi.fn(async (key: string) => settings[key] ?? null),
    meshcore,
  },
}));

import meshcorePacketLogService from './meshcorePacketLogService.js';

describe('MeshCorePacketLogService retention', () => {
  beforeEach(() => {
    for (const key of Object.keys(settings)) delete settings[key];
    vi.clearAllMocks();
  });

  afterAll(() => {
    meshcorePacketLogService.stop();
  });

  it('treats zero count and age as unlimited and skips both cleanup queries', async () => {
    settings.meshcore_packet_log_max_count = '0';
    settings.meshcore_packet_log_max_age_hours = '0';

    expect(await meshcorePacketLogService.getMaxCount()).toBe(0);
    expect(await meshcorePacketLogService.getMaxAgeHours()).toBe(0);

    await meshcorePacketLogService.runCleanup();

    expect(meshcore.deletePacketsOlderThan).not.toHaveBeenCalled();
    expect(meshcore.getPacketLogSourceIds).not.toHaveBeenCalled();
    expect(meshcore.trimPacketsToCount).not.toHaveBeenCalled();
  });
});
