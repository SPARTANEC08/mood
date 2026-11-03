/* Тема до первого кадра: без этого при светлой теме будет вспышка тёмного. */
    (function () {
      var root = document.documentElement;
      root.classList.add("js");

      // Если лендинг всё-таки установили как PWA (особенно на iOS, где
      // «На экран Домой» берёт текущий адрес), иконка не должна открывать
      // маркетинговую страницу. Уходим в приложение; там будет вход или
      // сохранённая сессия.
      var params = new URLSearchParams(window.location.search);
      var fromMigration = params.get("from") === "migration";

      var standalone =
        window.navigator.standalone === true ||
        (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        document.referrer.indexOf("android-app://") === 0;

      // Старая PWA из Швеции открывает лендинг внутри standalone-контекста.
      // Для ссылки из статьи переезда оставляем лендинг, иначе человек увидит
      // экран авторизации вместо инструкции по установке.
      if (standalone && !fromMigration) {
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
