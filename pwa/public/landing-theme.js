/* Тема до первого кадра: без этого при светлой теме будет вспышка тёмного. */
    (function () {
      var root = document.documentElement;
      root.classList.add("js");

      // Если лендинг всё-таки установили как PWA (особенно на iOS, где
      // «На экран Домой» берёт текущий адрес), иконка не должна открывать
      // маркетинговую страницу. Уходим в приложение; там будет вход или
      // сохранённая сессия.
      var standalone =
        window.navigator.standalone === true ||
        (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        document.referrer.indexOf("android-app://") === 0;

      if (standalone) {
        window.location.replace("/");
        return;
      }

      try {
        var saved = localStorage.getItem("mood-landing-theme");
        if (saved === "light" || saved === "dark") {
          root.setAttribute("data-theme", saved);
        }
      } catch (error) {
        /* localStorage может быть недоступен */
      }
    })();
