/**
 * Проверка изоляции данных по группам.
 *
 * Закрываемый сценарий: раньше по угаданному callback_data вида
 * `imp:<id>` / `hw_detail:<id>` / `imp_del_confirm:<id>` / `hw_del_confirm:<id>`
 * можно было прочитать или удалить запись ЧУЖОЙ группы вместе с её файлами.
 *
 * Проверяем обратное:
 *   - внутри группы всё работает (любой одногруппник читает, добавляет и удаляет —
 *     эти права намеренно не менялись);
 *   - чужой группе недоступно ничего, включая ссылки на файлы;
 *   - файл одного пользователя недоступен другому даже по прямому fileId;
 *   - не авторизованный пользователь (пустая группа) не видит вообще ничего.
 *
 * Тест работает в отдельном каталоге: process.cwd() сменяется до импорта
 * хранилищ, поэтому реальные data/*.json не затрагиваются.
 *
 * Запуск: npx tsx scripts/test-group-isolation.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALPHA = 'ИЭ-11-26';
const BETA = 'ИЖ-42-26';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  // Песочница: хранилища берут путь из process.cwd() при загрузке модуля,
  // поэтому каталог меняется до импорта.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gi-'));
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
  process.chdir(sandbox);

  const { homeworkStore } = await import('../src/storage/homeworkStore.ts');
  const { importantStore } = await import('../src/storage/importantStore.ts');
  const { makeRecordId } = await import('../src/bot/format.ts');

  const { getFile, saveFile } = await import('../src/storage/fileStore.ts');

  const alphaImp = 'imp_test_alpha_0001';
  const betaImp = 'imp_test_beta_0001';
  const alphaHw = 'hw_test_alpha_0001';
  const betaHw = 'hw_test_beta_0001';

  const ALPHA_USER = '11111111-1111-4111-8111-111111111111';
  const BETA_USER = '22222222-2222-4222-8222-222222222222';

  /**
   * Ссылка на файл нового формата.
   *
   * Раньше здесь был `{ fileId, fileName }` — file_id из Telegram. Теперь файл
   * лежит на диске, и ссылка описывает его целиком: имя, размер и хэш. Проверка
   * изоляции от этого не меняется — она и раньше строилась на подстановке чужого
   * идентификатора записи.
   */
  const file = (fileId: string, uploadedBy: string) => [
    {
      fileId,
      originalName: `${fileId}.pdf`,
      mimeType: 'application/pdf',
      size: 10,
      sha256: 'f'.repeat(64),
      uploadedBy,
      uploadedAt: new Date().toISOString(),
    },
  ];

  importantStore.save({
    id: alphaImp, groupName: ALPHA, title: 'Секрет ALPHA', text: 'ALPHA only',
    files: file('alpha_secret_file', ALPHA_USER), authorId: ALPHA_USER, createdAt: new Date().toISOString(),
  });
  importantStore.save({
    id: betaImp, groupName: BETA, title: 'Секрет BETA', text: 'BETA only',
    files: file('beta_secret_file', BETA_USER), authorId: BETA_USER, createdAt: new Date().toISOString(),
  });
  homeworkStore.save({
    id: alphaHw, groupName: ALPHA, discipline: 'Матан', kind: 'practice',
    targetDate: '2026.10.20', text: 'ДЗ ALPHA', files: file('alpha_hw_file', ALPHA_USER),
    authorId: ALPHA_USER, createdAt: new Date().toISOString(),
  });
  homeworkStore.save({
    id: betaHw, groupName: BETA, discipline: 'Физика', kind: 'lab',
    targetDate: '2026.10.20', text: 'ДЗ BETA', files: file('beta_hw_file', BETA_USER),
    authorId: BETA_USER, createdAt: new Date().toISOString(),
  });

  console.log('\n— Чтение объявлений —');
  check('своя группа читает своё объявление',
    importantStore.getForGroupAndId(ALPHA, alphaImp)?.title === 'Секрет ALPHA');
  check('чужая группа НЕ читает объявление',
    importantStore.getForGroupAndId(BETA, alphaImp) === undefined);
  check('список ALPHA не содержит объявлений BETA',
    !importantStore.getForGroup(ALPHA).some((m) => m.id === betaImp));
  check('список BETA не содержит объявлений ALPHA',
    !importantStore.getForGroup(BETA).some((m) => m.id === alphaImp));

  console.log('\n— Чтение ДЗ —');
  check('своя группа читает своё ДЗ',
    homeworkStore.getForGroupAndId(ALPHA, alphaHw)?.discipline === 'Матан');
  check('чужая группа НЕ читает ДЗ',
    homeworkStore.getForGroupAndId(BETA, alphaHw) === undefined);
  check('список ДЗ ALPHA не содержит ДЗ BETA',
    !homeworkStore.getUpcoming(ALPHA, '2000.01.01').some((h) => h.id === betaHw));
  check('список ДЗ BETA не содержит ДЗ ALPHA',
    !homeworkStore.getUpcoming(BETA, '2000.01.01').some((h) => h.id === alphaHw));

  /*
   * Изоляция проверяется на уровне хранилища, а не экранов.
   *
   * Раньше здесь стояла проверка «чужое объявление не рендерится», потому что
   * утечка шла именно через экран: глобальный get(id) отдавал запись любой
   * группы по угаданному callback_data вместе со ссылками на файлы. Экранов у
   * бота больше нет, но сама граница никуда не делась — она переехала в
   * getForGroupAndId, и именно её проверяем.
   */
  console.log('\n— Чужая запись не отдаётся по своему id —');
  check('чужое объявление не достаётся по id',
    importantStore.getForGroupAndId(BETA, alphaImp) === undefined);
  check('своё объявление достаётся',
    importantStore.getForGroupAndId(ALPHA, alphaImp)?.id === alphaImp);
  check('чужое ДЗ не достаётся по id',
    homeworkStore.getForGroupAndId(BETA, alphaHw) === undefined);
  check('своё ДЗ достаётся',
    homeworkStore.getForGroupAndId(ALPHA, alphaHw)?.id === alphaHw);

  console.log('\n— Файлы разделены по пользователю —');
  {
    // Файл лежит в data/files/<userId>/, поэтому чужая ссылка ведёт в каталог,
    // которого у запрашивающего просто нет. Проверяется на настоящем файле:
    // подставленный fileId из чужого каталога обязан вернуть null.
    const saved = await saveFile(
      ALPHA_USER,
      Buffer.from('%PDF-1.4\nсодержимое файла ALPHA'),
      'alpha_hw_file.pdf',
      'application/pdf',
      ALPHA_USER,
    );

    check('свой файл читается', (await getFile(ALPHA_USER, saved.fileId)) !== null);
    check(
      'чужой пользователь по тому же fileId не получает файл',
      (await getFile(BETA_USER, saved.fileId)) === null,
    );
    check('несуществующий файл → null', (await getFile(ALPHA_USER, '00000000-0000-4000-8000-000000000000')) === null);
    check('мусор вместо fileId → null, а не исключение', (await getFile(ALPHA_USER, '../../etc/passwd')) === null);
    check(
      'файл чужого пользователя не виден даже с корректным UUID чужого каталога',
      (await getFile(BETA_USER, saved.fileId)) === null,
    );
  }

  console.log('\n— Не авторизован (группа не определена) —');
  check('пустая группа не читает объявление',
    importantStore.getForGroupAndId('', alphaImp) === undefined);
  check('пустая группа не читает ДЗ',
    homeworkStore.getForGroupAndId('', alphaHw) === undefined);
  check('группа из пробелов не обходит проверку',
    importantStore.getForGroupAndId('   ', alphaImp) === undefined);

  console.log('\n— Нормализация имени группы —');
  check('регистр и пробелы не мешают своей группе',
    importantStore.getForGroupAndId('  иэ-11-26  ', alphaImp) !== undefined);
  check('похожая группа не проходит',
    importantStore.getForGroupAndId(`${ALPHA}1`, alphaImp) === undefined);

  console.log('\n— Удаление из чужой группы —');
  check('чужая группа НЕ удаляет объявление',
    importantStore.deleteForGroupAndId(BETA, alphaImp) === undefined);
  check('объявление ALPHA осталось на месте',
    importantStore.get(alphaImp) !== undefined);
  check('чужая группа НЕ удаляет ДЗ',
    homeworkStore.deleteForGroupAndId(BETA, alphaHw) === undefined);
  check('ДЗ ALPHA осталось на месте',
    homeworkStore.get(alphaHw) !== undefined);

  console.log('\n— Права внутри группы сохранены (удаление разрешено всем) —');
  check('своя группа МОЖЕТ удалить объявление',
    importantStore.deleteForGroupAndId(ALPHA, alphaImp)?.id === alphaImp);
  check('своя группа МОЖЕТ удалить ДЗ',
    homeworkStore.deleteForGroupAndId(ALPHA, alphaHw)?.id === alphaHw);

  console.log('\n— Соседние группы не задеты —');
  check('объявление BETA цело',
    importantStore.getForGroupAndId(BETA, betaImp) !== undefined);
  check('ДЗ BETA цело',
    homeworkStore.getForGroupAndId(BETA, betaHw) !== undefined);

  console.log('\n— Привязка файлов: чужой файл не прикрепить —');
  {
    const { resolveOwnedFiles, RecordFilesError } = await import('../src/server/routes/recordFiles.ts');

    // Файл принадлежит ALPHA_USER; пользователь BETA не должен привязать его
    // к своей записи, даже зная корректный fileId.
    const owned = await saveFile(
      ALPHA_USER,
      Buffer.from('%PDF-1.4\nчужой файл'),
      'secret.pdf',
      'application/pdf',
      ALPHA_USER,
    );

    let rejected = false;
    try {
      await resolveOwnedFiles(BETA_USER, [owned.fileId]);
    } catch (err: unknown) {
      rejected = err instanceof RecordFilesError;
    }
    check('чужой файл не привязывается (RecordFilesError)', rejected);

    const own = await resolveOwnedFiles(ALPHA_USER, [owned.fileId]);
    check('свой файл привязывается', own.length === 1 && own[0]?.fileId === owned.fileId);
  }

  console.log('\n— Антифлуд записей: общий счётчик ДЗ и «Важного» —');
  {
    const { checkRecordRateLimit, MAX_RECORDS_PER_HOUR } = await import('../src/server/routes/recordShared.ts');

    const user = '33333333-3333-4333-8333-333333333333';
    let verdict = { limited: false, retryAfterMs: 0 };
    for (let i = 0; i < MAX_RECORDS_PER_HOUR; i += 1) {
      verdict = checkRecordRateLimit(user);
    }
    check(`${MAX_RECORDS_PER_HOUR} записей за час разрешены`, verdict.limited === false);

    const overflow = checkRecordRateLimit(user);
    check('следующая запись отклонена (429)', overflow.limited === true);
    check('Retry-After в пределах окна', overflow.retryAfterMs > 0 && overflow.retryAfterMs <= 3_600_000);

    // У другого пользователя свой счётчик: лимит по пользователю, не глобальный.
    check('другой пользователь не задет', checkRecordRateLimit('44444444-4444-4444-8444-444444444444').limited === false);
  }

  console.log('\n— Пустая группа не видит списки —');
  check('getForGroup объявлений пустой группы пуст', importantStore.getForGroup('').length === 0);
  check('getUpcoming ДЗ пустой группы пуст', homeworkStore.getUpcoming('', '2000.01.01').length === 0);
  check('getForSlot ДЗ пустой группы пуст', homeworkStore.getForSlot('', '2026.10.20', 1, ['Матан']).length === 0);

  console.log('\n— Неперебираемые ID —');
  const ids = new Set(Array.from({ length: 5000 }, () => makeRecordId('hw')));
  check('5000 идентификаторов уникальны', ids.size === 5000, `уникальных: ${ids.size}`);
  check('ID длинный (пробел перебора большой)', makeRecordId('hw').length >= 36);
  check('ID не содержит предсказуемой даты',
    !/^(hw|imp)_[a-z0-9]{8}$/.test(makeRecordId('hw')));

  console.log('\n— Права на файлы базы —');
  const st = fs.statSync(path.join(sandbox, 'data', 'homework.json'));
  check('файл базы доступен только владельцу (0600)',
    (st.mode & 0o777) === 0o600, `режим: 0${(st.mode & 0o777).toString(8)}`);
  const dst = fs.statSync(path.join(sandbox, 'data'));
  check('каталог данных закрыт (0700)',
    (dst.mode & 0o777) === 0o700, `режим: 0${(dst.mode & 0o777).toString(8)}`);

  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(
    `\n${failures === 0 ? '✅ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `❌ ПРОВАЛЕНО: ${failures} из ${checks}`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('Ошибка теста:', err);
  process.exit(1);
});
