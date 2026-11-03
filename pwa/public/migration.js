/*
 * Старая PWA открывает ссылки внутри себя. Перед переходом на mood-app.ru
 * показываем окно с просьбой открыть сайт в браузере и кнопкой копирования.
 */
(function () {
  var modal = document.getElementById('browser-modal');
  var copyButton = document.getElementById('browser-modal-copy');
  var openLink = document.getElementById('browser-modal-open');
  var closeButton = document.getElementById('browser-modal-close');
  if (!modal || !copyButton || !openLink || !closeButton) return;

  var target = 'https://mood-app.ru';

  function openModal(href) {
    target = href || 'https://mood-app.ru';
    openLink.href = target;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    copyButton.textContent = 'Скопировать mood-app.ru';
    closeButton.focus();
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  document.querySelectorAll('a[href*="mood-app.ru"]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      openModal(link.href || 'https://mood-app.ru');
    });
  });

  copyButton.addEventListener('click', function () {
    var text = 'https://mood-app.ru';
    var done = function () {
      copyButton.textContent = 'Скопировано — вставьте в Safari/Chrome';
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        window.prompt('Скопируйте адрес и откройте его в браузере:', text);
      });
      return;
    }

    window.prompt('Скопируйте адрес и откройте его в браузере:', text);
  });

  closeButton.addEventListener('click', closeModal);
  modal.addEventListener('click', function (event) {
    if (event.target === modal) closeModal();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });
})();
