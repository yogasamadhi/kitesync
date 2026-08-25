import { describe, expect, it, vi } from 'vitest';
import { HubReconciler } from './reconciler.js';

describe('HubReconciler', () => {
  it('does not reapply an already observed revision', async () => {
    const syncthing = { configureLanOnly: vi.fn() };
    const store = {
      load: vi.fn().mockResolvedValue({ revision: 2, devices: [], folders: [] }),
      save: vi.fn(),
    };
    const reconciler = new HubReconciler(syncthing as never, store as never);
    const operation = await reconciler.submit({ revision: 2, devices: [], folders: [] });
    expect(operation.state).toBe('succeeded');
    expect(syncthing.configureLanOnly).not.toHaveBeenCalled();
  });

  it('rejects stale desired revisions', async () => {
    const store = {
      load: vi.fn().mockResolvedValue({ revision: 3, devices: [], folders: [] }),
      save: vi.fn(),
    };
    const reconciler = new HubReconciler({} as never, store as never);
    await expect(reconciler.submit({ revision: 2, devices: [], folders: [] })).rejects.toThrow(
      /older/,
    );
  });
});
