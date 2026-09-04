import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@kitesync/ui';
import { api } from './api.js';

export interface SelectedDirectory {
  id: string;
  label: string;
}

export function DirectoryPicker({
  selected,
  onSelect,
}: {
  selected: SelectedDirectory | undefined;
  onSelect: (directory: SelectedDirectory) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [currentId, setCurrentId] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const roots = useQuery({
    queryKey: ['directory-roots'],
    queryFn: api.directoryRoots,
    enabled: opened,
  });
  const listing = useQuery({
    queryKey: ['directories', currentId, cursor],
    queryFn: () => api.directories(currentId!, { ...(cursor ? { cursor } : {}), limit: 100 }),
    enabled: opened && Boolean(currentId),
  });

  function navigate(id: string | undefined) {
    setCurrentId(id);
    setCursor(undefined);
    setCursorHistory([]);
  }

  function closeWith(directory: SelectedDirectory) {
    onSelect(directory);
    setOpened(false);
  }

  return (
    <div className="directory-picker">
      <button type="button" className="directory-trigger" onClick={() => setOpened(!opened)}>
        <span aria-hidden="true">▱</span>
        <span>
          <b>{selected?.label ?? '选择本机目录'}</b>
          <small>{selected ? '目录已选择，可点击更改' : '只会向服务传递临时目录标识'}</small>
        </span>
        <i>{opened ? '收起' : '浏览'}</i>
      </button>

      {opened && (
        <div className="directory-popover">
          {!currentId ? (
            <>
              <div className="picker-title">
                <b>可用位置</b>
                <small>请选择一个位置继续</small>
              </div>
              {roots.isLoading && <p className="muted-line">正在读取本机目录…</p>}
              {roots.data?.items.map((root) => (
                <button
                  type="button"
                  className="directory-row"
                  key={root.id}
                  onClick={() => navigate(root.id)}
                >
                  <span className="folder-glyph">▱</span>
                  <b>{root.label}</b>
                  <span>›</span>
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="picker-toolbar">
                <button
                  type="button"
                  onClick={() => navigate(listing.data?.parentId ?? undefined)}
                  aria-label="返回上一级"
                >
                  ←
                </button>
                <div>
                  <b>{listing.data?.current.label ?? '正在读取…'}</b>
                  <small>当前目录</small>
                </div>
                {listing.data && (
                  <Button type="button" onClick={() => closeWith(listing.data.current)}>
                    选择这里
                  </Button>
                )}
              </div>
              {listing.isLoading && <p className="muted-line">正在读取子目录…</p>}
              {listing.isError && <p className="form-error">无法读取此目录</p>}
              {listing.data?.items.map((entry) => (
                <button
                  type="button"
                  className="directory-row"
                  key={entry.id}
                  onClick={() => navigate(entry.id)}
                >
                  <span className="folder-glyph">▱</span>
                  <b>{entry.name}</b>
                  <span>›</span>
                </button>
              ))}
              {listing.data?.items.length === 0 && (
                <p className="muted-line">这里没有子目录，可以直接选择当前目录。</p>
              )}
              {(cursorHistory.length > 0 || listing.data?.nextCursor) && (
                <div className="pagination">
                  <button
                    type="button"
                    disabled={!cursorHistory.length}
                    onClick={() => {
                      const history = [...cursorHistory];
                      setCursor(history.pop());
                      setCursorHistory(history);
                    }}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    disabled={!listing.data?.nextCursor}
                    onClick={() => {
                      if (!listing.data?.nextCursor) return;
                      setCursorHistory((history) => [...history, cursor ?? '']);
                      setCursor(listing.data.nextCursor ?? undefined);
                    }}
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
