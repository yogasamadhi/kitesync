import { KiteSyncApiClient } from '@kitesync/api-client';

export const api = new KiteSyncApiClient();

export { ApiError } from '@kitesync/api-client';
export type { AuthSession, NodeInfo } from '@kitesync/contracts';
