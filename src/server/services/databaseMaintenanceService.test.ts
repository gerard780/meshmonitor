import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settings, database, expireSweep } = vi.hoisted(() => {
  const settingsStore: Record<string, string> = {};
  return {
    settings: settingsStore,
    database: {
      drizzleDbType: 'sqlite' as const,
      settings: {
        getSetting: vi.fn(async (key: string) => settingsStore[key] ?? null),
        setSetting: vi.fn(async () => undefined),
      },
      getDatabaseSizeAsync: vi.fn(async () => 1024),
      cleanupOldMessagesAsync: vi.fn(async () => 1),
      cleanupOldTraceroutesAsync: vi.fn(async () => 1),
      cleanupOldRouteSegmentsAsync: vi.fn(async () => 1),
      cleanupOldNeighborInfoAsync: vi.fn(async () => 1),
      vacuumAsync: vi.fn(async () => undefined),
      deadDrop: {
        purgeExpired: vi.fn(async () => 0),
      },
    },
    expireSweep: vi.fn(async () => 0),
  };
});

vi.mock('../../services/database.js', () => ({ default: database }));
vi.mock('./waypointService.js', () => ({ waypointService: { expireSweep } }));

import { databaseMaintenanceService } from './databaseMaintenanceService.js';

describe('DatabaseMaintenanceService retention', () => {
  beforeEach(() => {
    for (const key of Object.keys(settings)) delete settings[key];
    vi.clearAllMocks();
    settings.messageRetentionDays = '0';
    settings.tracerouteRetentionDays = '0';
    settings.routeSegmentRetentionDays = '0';
    settings.neighborInfoRetentionDays = '0';
  });

  it('reports zero as unlimited and skips each configurable data cleanup', async () => {
    const status = await databaseMaintenanceService.getStatus();
    expect(status.settings).toEqual({
      messageRetentionDays: 0,
      tracerouteRetentionDays: 0,
      routeSegmentRetentionDays: 0,
      neighborInfoRetentionDays: 0,
    });

    const result = await databaseMaintenanceService.runMaintenance();

    expect(database.cleanupOldMessagesAsync).not.toHaveBeenCalled();
    expect(database.cleanupOldTraceroutesAsync).not.toHaveBeenCalled();
    expect(database.cleanupOldRouteSegmentsAsync).not.toHaveBeenCalled();
    expect(database.cleanupOldNeighborInfoAsync).not.toHaveBeenCalled();
    expect(result.messagesDeleted).toBe(0);
    expect(result.traceroutesDeleted).toBe(0);
    expect(result.routeSegmentsDeleted).toBe(0);
    expect(result.neighborInfoDeleted).toBe(0);
    expect(database.vacuumAsync).toHaveBeenCalledOnce();
  });
});
