import { assertSyncthingBuild, assertSyncthingSource } from './syncthing-source.mjs';

assertSyncthingSource();
const marker = assertSyncthingBuild();
console.log(
  `Syncthing source build verified for ${marker.platform}-${marker.arch}; sha256=${marker.sha256}`,
);
