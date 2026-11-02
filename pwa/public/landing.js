(function () {
      var root = document.documentElement;
      root.classList.add("js");

      /* ── тема ─────────────────────────────────────────────── */
      try {
        var storedTheme = localStorage.getItem("mood-landing-theme");
        if (storedTheme === "light" || storedTheme === "dark") {
          root.setAttribute("data-theme", storedTheme);
        }
      } catch (error) {
        /* localStorage может быть недоступен в приватном режиме */
      }

      var themeMeta = document.querySelector('meta[name="theme-color"]');

      function syncThemeColor() {
        if (!themeMeta) return;
        themeMeta.setAttribute(
          "content",
          root.getAttribute("data-theme") === "light" ? "#f4f2fb" : "#0c0a12"
        );
      }

      syncThemeColor();

      var themeToggle = document.querySelector("[data-theme-toggle]");
      if (themeToggle) {
        themeToggle.addEventListener("click", function () {
          var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
          root.setAttribute("data-theme", next);
          syncThemeColor();
          try {
            localStorage.setItem("mood-landing-theme", next);
          } catch (error) {
            /* тихо игнорируем */
          }
        });
      }

      /* ── шапка при скролле ────────────────────────────────── */
      var header = document.querySelector("[data-header]");
      function syncHeader() {
        if (!header) return;
        header.classList.toggle("scrolled", window.scrollY > 8);
      }
      syncHeader();
      window.addEventListener("scroll", syncHeader, { passive: true });

      /* ── мобильное меню ───────────────────────────────────── */
      var menuButton = document.querySelector("[data-menu-toggle]");
      var nav = document.querySelector("[data-nav]");

      function closeMenu() {
        if (!nav || !menuButton) return;
        nav.setAttribute("data-open", "false");
        menuButton.setAttribute("aria-expanded", "false");
        menuButton.setAttribute("aria-label", "Открыть меню");
      }

      if (menuButton && nav) {
        menuButton.addEventListener("click", function () {
          var isOpen = nav.getAttribute("data-open") === "true";
          nav.setAttribute("data-open", String(!isOpen));
          menuButton.setAttribute("aria-expanded", String(!isOpen));
          menuButton.setAttribute("aria-label", isOpen ? "Открыть меню" : "Закрыть меню");
        });

        nav.querySelectorAll("a").forEach(function (link) {
          link.addEventListener("click", closeMenu);
        });

        window.addEventListener("resize", function () {
          if (window.innerWidth > 860) closeMenu();
        });
      }

      /* ── вкладки установки ────────────────────────────────── */
      var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-tab]"));
      var panels = Array.prototype.slice.call(document.querySelectorAll("[data-panel]"));

      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          var id = tab.getAttribute("data-tab");
          tabs.forEach(function (item) {
            item.setAttribute("aria-selected", String(item === tab));
          });
          panels.forEach(function (panel) {
            panel.hidden = panel.getAttribute("data-panel") !== id;
          });
        });
      });

      /* ── появление секций ─────────────────────────────────── */
      var revealItems = Array.prototype.slice.call(document.querySelectorAll(".reveal"));

      if ("IntersectionObserver" in window) {
        var observer = new IntersectionObserver(
          function (entries) {
            entries.forEach(function (entry) {
              if (!entry.isIntersecting) return;
              entry.target.classList.add("is-visible");
              observer.unobserve(entry.target);
            });
          },
          { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
        );

        revealItems.forEach(function (item) {
          observer.observe(item);
        });
      } else {
        revealItems.forEach(function (item) {
          item.classList.add("is-visible");
        });
      }
    })();
