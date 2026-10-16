import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { ServerFileRef } from '@/types/api';

/**
 * Миниатюра в строке файла.
 *
 * Берётся ПРЕВЬЮ, а не оригинал: строка файла — это 44×44 пикселя, а фотография
 * под ней весит несколько мегабайт. Превю в 800 пикселей — около ста килобайт,
 * и на мобильном интернете лента появляется сразу.
 *
 * Если превью построить не удалось, api.previewUrl сам отдаёт оригинал, поэтому
 * компонент ни о фото, ни о превью не знает.
 *
 * Полноэкранный просмотр живое в InAppBrowser (см. InAppBrowser.tsx): тап по
 * файлу открывает вкладку внутри приложения, и та же миниатюра служит первым
 * кадром, пока оригинал догружается. Поэтому URL превью переиспользуется, а не
 * создаётся заново.
 */

function isImage(file: ServerFileRef): boolean {
  return file.mimeType.startsWith('image/');
}

export function FileThumbnail({ file }: { file: ServerFileRef }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;

    if (!isImage(file)) {
      setFailed(true);
      return;
    }

    api
      .previewUrl(file.fileId)
      .then((resolved) => {
        if (alive) setUrl(resolved);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
    };
  }, [file]);

  if (failed) return null;

  return (
    <span
      className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden"
      style={{ borderRadius: '8px', background: 'var(--surface-2)' }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
