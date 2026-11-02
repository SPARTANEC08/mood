/* Тема до первого кадра: без этого при светлой теме будет вспышка тёмного. */
    (function () {
      var root = document.documentElement;
      root.classList.add("js");

      try {
        var saved = localStorage.getItem("mood-landing-theme");
        if (saved === "light" || saved === "dark") {
          root.setAttribute("data-theme", saved);
        }
      } catch (error) {
        /* localStorage может быть недоступен */
      }
    })();
