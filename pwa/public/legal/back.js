/**
 * Кнопка «Назад» на юридических страницах.
 *
 * Если страница открыта из приложения (тот же origin и есть история) —
 * возвращаемся назад. Если открыта по прямой ссылке или из внешнего источника —
 * ведём на fallback, указанный в data-fallback.
 */
(() => {
  const link = document.querySelector('.legal-back');
  if (!link) return;

  const fallback = link.dataset.fallback || '/';
  link.setAttribute('href', fallback);

  link.addEventListener('click', (event) => {
    if (history.length <= 1) return;

    const ref = document.referrer;
    if (!ref) return;

    try {
      if (new URL(ref).origin !== location.origin) return;
    } catch {
      return;
    }

    event.preventDefault();
    history.back();
  });
})();
