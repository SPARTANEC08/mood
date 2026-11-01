/**
 * Тесты краевых случаев файлового слоя: имена, типы, размеры, превью.
 *
 * Здесь проверяются ЧИСТЫЕ функции и константы. Полный цикл загрузки/скачивания
 * и share-ссылка покрыты в test:files (test-file-roundtrip), здесь — то, что
 * легко сломать незаметно: обход пути в имени, несоответствие MIME и расширения,
 * границы ширины превью.
 *
 * Запуск: npm run test:files-edges
 */

import {
  ALLOWED_MIME_TYPES,
  assertAllowedType,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_RECORD,
  MAX_USER_STORAGE_BYTES,
  sanitizeFileName,
} from '../../db/storage/fileStore.ts';
import {
  DEFAULT_PREVIEW_WIDTH,
  isPreviewable,
  MAX_PREVIEW_WIDTH,
  normalizePreviewWidth,
} from '../../db/storage/filePreview.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

/** true, если вызов бросил (ожидаем отказ). */
function throws(run: () => void): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}

console.log('====================================================');
console.log('   ТЕСТЫ ФАЙЛОВ: КРАЕВЫЕ СЛУЧАИ');
console.log('====================================================');

section('Имя файла: обход пути и мусор');
{
  check('убирает unix-путь', sanitizeFileName('/etc/passwd') === 'passwd', sanitizeFileName('/etc/passwd'));
  check('убирает windows-путь', sanitizeFileName('..\\..\\Windows\\system32\\cmd.exe') === 'cmd.exe', sanitizeFileName('..\\..\\Windows\\system32\\cmd.exe'));
  check('убирает управляющие символы', sanitizeFileName('a\u0000b\u001fc.txt') === 'abc.txt', JSON.stringify(sanitizeFileName('a\u0000b\u001fc.txt')));
  check('убирает кавычки', sanitizeFileName('отчёт".pdf') === 'отчёт.pdf', sanitizeFileName('отчёт".pdf'));
  check('пустое имя → file', sanitizeFileName('   ') === 'file', sanitizeFileName('   '));
  check('слишком длинное имя обрезается', sanitizeFileName('x'.repeat(500)).length === 120);
  check('обычное имя не трогается', sanitizeFileName('фото с пар.jpg') === 'фото с пар.jpg');
}

section('Типы: MIME и расширение должны совпадать');
{
  check('jpeg+jpg проходит', !throws(() => assertAllowedType('image/jpeg', 'photo.jpg')));
  check('png+png проходит', !throws(() => assertAllowedType('image/png', 'a.png')));
  check('MIME с параметрами нормализуется', !throws(() => assertAllowedType('image/png; charset=binary', 'a.png')));
  check('pdf+pdf проходит', !throws(() => assertAllowedType('application/pdf', 'doc.pdf')));
  check('txt+txt проходит', !throws(() => assertAllowedType('text/plain', 'notes.txt')));

  check('jpeg с расширением .pdf отклонён', throws(() => assertAllowedType('image/jpeg', 'doc.pdf')));
  check('png с расширением .jpg отклонён', throws(() => assertAllowedType('image/png', 'photo.jpg')));
  check('исполняемый MIME отклонён', throws(() => assertAllowedType('application/x-msdownload', 'virus.exe')));
  check('svg отклонён (не в списке)', throws(() => assertAllowedType('image/svg+xml', 'a.svg')));
  check('без расширения отклонён', throws(() => assertAllowedType('image/png', 'noext')));
  check('пустой MIME отклонён', throws(() => assertAllowedType('', 'a.png')));
}

section('Лимиты');
{
  check('размер файла 20 МБ', MAX_FILE_SIZE_BYTES === 20 * 1024 * 1024);
  check('файлов на запись 10', MAX_FILES_PER_RECORD === 10);
  check('квота пользователя 100 МБ', MAX_USER_STORAGE_BYTES === 100 * 1024 * 1024);
  check('в allowlist нет исполняемых типов', ![...ALLOWED_MIME_TYPES].some((m) => /executable|x-msdownload|javascript/.test(m)));
}

section('Превью: границы ширины');
{
  check('по умолчанию 800', normalizePreviewWidth(undefined) === DEFAULT_PREVIEW_WIDTH);
  check('NaN → дефолт', normalizePreviewWidth('abc') === DEFAULT_PREVIEW_WIDTH);
  // Принимаются только 200/400/800/1200: всё остальное приводится к ближайшей
  // разрешённой ширине, чтобы одна картинка не плодила тысячи превью.
  check('слишком мало → 200', normalizePreviewWidth(1) === 200);
  check('слишком много зажимается к 1200', normalizePreviewWidth(999999) === MAX_PREVIEW_WIDTH && MAX_PREVIEW_WIDTH === 1200);
  check('640 → ближайшее 800', normalizePreviewWidth('640') === 800);
  check('дробная строка → 800', normalizePreviewWidth('640.7') === 800, String(normalizePreviewWidth('640.7')));
  check('дробное число → 800', normalizePreviewWidth(640.7) === 800, String(normalizePreviewWidth(640.7)));
  check('разрешённая ширина сохраняется', normalizePreviewWidth(400) === 400);

  check('изображения превьюируются', isPreviewable('image/jpeg') && isPreviewable('image/png'));
  check('pdf не превьюируется картинкой', !isPreviewable('application/pdf'));
  check('undefined не превьюируется', !isPreviewable(undefined));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
