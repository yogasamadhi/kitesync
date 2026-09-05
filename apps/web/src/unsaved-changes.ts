import { useEffect } from 'react';

let activeDrafts = 0;

export function useUnsavedChanges(active: boolean) {
  useEffect(() => {
    if (!active) return;
    activeDrafts += 1;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => {
      activeDrafts = Math.max(0, activeDrafts - 1);
      window.removeEventListener('beforeunload', warn);
    };
  }, [active]);
}

export function confirmDiscardChanges() {
  return activeDrafts === 0 || window.confirm('有尚未保存的更改，确定离开吗？');
}
