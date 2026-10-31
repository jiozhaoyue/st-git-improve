/**
 * standalone/standalone-hook.js — 原生酒馆纯浏览器脱机兼容层（Standalone Browser Hook）
 * 参照 ST-chatfilesys-rebuild/standalone/standalone-hook.js 同款机制改写。
 *
 * 责任（决策 D7-1/D7-2）：
 * 1. 拦截 window.fetch 与 XMLHttpRequest，在浏览器内存中响应 SillyTavern 原生 API；
 * 2. 彻底脱离 Node.js 后端运行时，使原生 index.html / script.js 及原生前端组件在纯静态环境正常运行；
 * 3. 注册本仓扩展 third-party/st-git-improve（代码由 serve.js 映射到仓根 extension/，不经拷贝）。
 *
 * mock 原则（D7-2 最小 mock）：
 * - 仅伪造面板启动必需 API；写操作端点返回演示结果并附 standalonePreview: true（前端据此提示「脱机预览不执行」）；
 * - Authority 能力端点与旧服务端插件端点显式 404 —— 面板能力态应呈现「纯前端」模式；
 * - 未注册的 /api/* 兜底返回空默认值。
 */

(function () {
  console.info("[Standalone Hook] 正在安装酒馆原生脱机网络拦截器...");

  const ST_VERSION = "1.19.0";
  const EXTENSION_NAME = "third-party/st-git-improve";

  // ---------------------------------------------------------------- 内存态
  let cachedSettings = null;

  function demoResult(extra) {
    return Object.assign(
      {
        ok: true,
        standalonePreview: true,
        message: "脱机预览不执行（standalone 开发壳仅返回演示结果）",
      },
      extra || {}
    );
  }

  // ---------------------------------------------------------------- 工具
  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function text(str, status = 200) {
    return new Response(str, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // ---------------------------------------------------------------- 路由表
  const router = new Map();

  router.set("GET /csrf-token", () => json({ token: "standalone-csrf-token" }));
  router.set("GET /version", () =>
    json({
      agent: `SillyTavern:${ST_VERSION}:Standalone`,
      pkgVersion: ST_VERSION,
      version: ST_VERSION,
      gitBranch: "standalone",
      gitRevision: "local",
    })
  );
  router.set("POST /api/ping", () => new Response("", { status: 200 }));

  // 用户（D8-2：admin 标志 → 面板按管理员呈现； Authority 仍未装，管理功能仍灰化）
  router.set("GET /api/users/me", () =>
    json({
      handle: "default-user",
      name: "User",
      avatar: "img/user-default.png",
      admin: true,
      password: false,
      created: 0,
    })
  );
  router.set("POST /api/users/get", () =>
    json([
      {
        handle: "default-user",
        name: "User",
        avatar: "img/user-default.png",
        admin: true,
        password: false,
        created: 0,
      },
    ])
  );
  router.set("POST /api/users/current-avatar", () => json({ avatar: "img/user-default.png" }));

  // 密钥状态（boot 期 readSecretState 调用）：空对象 = 无任何已存密钥（真实端点同形：{ key: [...] }）
  router.set("POST /api/secrets/read", () => json({}));

  // 设置（内存 + default-settings.json 初始值；含本扩展键位与治理开关）
  router.set("POST /api/settings/get", async () => {
    if (!cachedSettings) {
      try {
        const raw = await originalFetch("default-settings.json");
        cachedSettings = await raw.json();
      } catch (e) {
        console.warn("[Standalone Hook] default-settings.json 加载失败，使用空设置", e);
        cachedSettings = {};
      }
    }
    if (!cachedSettings.extension_settings) cachedSettings.extension_settings = {};
    if (!cachedSettings.extension_settings.gitImprove) {
      cachedSettings.extension_settings.gitImprove = {};
    }
    if (!Array.isArray(cachedSettings.disabledExtensions)) {
      cachedSettings.disabledExtensions = [];
    }
    cachedSettings.firstRun = false;
    cachedSettings.active_character = "0";
    return json({
      settings: JSON.stringify(cachedSettings),
      koboldai_settings: [],
      koboldai_setting_names: [],
      novelai_settings: [],
      novelai_setting_names: [],
      openai_settings: [],
      openai_setting_names: [],
      textgenerationwebui_presets: [],
      textgenerationwebui_preset_names: [],
      instruct: [],
      context: [],
      sysprompt: [],
      reasoning: [],
      themes: [],
      movingUIPresets: [],
      quickReplyPresets: [],
      world_names: [],
      enable_extensions: true,
      enable_extensions_auto_update: false,
      enable_accounts: false,
      request_compression: {
        enabled: false,
        minPayloadSize: 0,
        maxPayloadSize: 0,
        timeout: 0,
      },
    });
  });

  router.set("POST /api/settings/save", async (req) => {
    try {
      const data = await req.json();
      cachedSettings = Object.assign(cachedSettings || {}, data);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // 关键：扩展发现接口，告诉原生酒馆本仓 st-git-improve 已安装（D7-1 原生壳加载真扩展）
  router.set("GET /api/extensions/discover", () => json([{ name: EXTENSION_NAME, type: "local" }]));

  // 宿主通道写操作：脱机预览只返回演示结果（D7-2），前端据 standalonePreview 提示「脱机预览不执行」
  router.set("POST /api/extensions/install", async () =>
    json(demoResult({ status: "demo-installed", name: EXTENSION_NAME }))
  );
  router.set("POST /api/extensions/delete", async () =>
    json(demoResult({ status: "demo-deleted" }))
  );
  router.set("POST /api/extensions/move", () => {
    // 实测契约（ST 1.19）：move 成功返回 204 无 body —— 演示态保持同码，标记走响应头
    return new Response("", {
      status: 204,
      headers: { "X-Standalone-Preview": "true" },
    });
  });

  // Authority 能力清单（design.md §5 契约草案 v0）：脱机壳内 Authority 未装 → 404，面板呈现纯前端态
  router.set("GET /api/plugins/authority/ext-mgmt/capabilities", () =>
    json({ error: "not_available_in_standalone", reason: "standalone-preview", remedy: "n/a" }, 404)
  );
  // 旧服务端插件（本仓 plugin/ 时代）在纯前端形态不存在 → 404
  router.set("GET /api/plugins/st-git-improve/status", () =>
    json({ error: "not_available_in_standalone" }, 404)
  );

  // 原生 UI 启动依赖的最小端点（面板开发无需演示聊天数据，返回空集即可）
  router.set("POST /api/characters/all", () => json([]));
  router.set("POST /api/characters/get", () => json({ error: "empty in standalone" }, 503));
  router.set("POST /api/chats/recent", () => json([]));
  router.set("POST /api/backgrounds/all", () => json({ images: [], config: {} }));
  router.set("POST /api/backgrounds/folders", () => json({ folders: [], imageFolderMap: {} }));
  router.set("POST /api/avatars/get", () => json(["img/user-default.png"]));
  router.set("POST /api/worldinfo/list", () => json([]));
  router.set("POST /api/horde/status", () => json({ ok: false }));
  router.set("POST /api/horde/text-models", () => json([]));
  router.set("POST /api/groups/all", () => json([]));
  router.set("POST /api/image-metadata/all", () => json({ images: {} }));

  // ---------------------------------------------------------------- fetch 拦截
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    let url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method = (
      (init && init.method) ||
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    try {
      const parsed = new URL(url, window.location.href);
      const routeKey = `${method} ${parsed.pathname}`;

      if (router.has(routeKey)) {
        console.log(`[Standalone Hook] Handled route: ${routeKey}`);
        const handler = router.get(routeKey);
        const req = input instanceof Request ? input : new Request(url, init);
        return await handler(req, parsed);
      }

      // 未显式注册的 /api/* 兜底：返回空默认值（chatfilesys 同款）
      if (parsed.pathname.startsWith("/api/")) {
        console.warn(
          `[Standalone Hook] 未显式注册的 API 请求: ${routeKey}，返回空默认值`
        );
        // 持久化补漏清单（跨 reload）：壳验收时从 localStorage 读取
        try {
          const missed = JSON.parse(localStorage.getItem("__stgiHookMissed") || "[]");
          if (!missed.includes(routeKey)) {
            missed.push(routeKey);
            localStorage.setItem("__stgiHookMissed", JSON.stringify(missed));
          }
        } catch { /* 存储不可用不影响兜底 */ }
        return json({ ok: true, items: [] });
      }
    } catch (e) {
      console.error("[Standalone Hook] URL 解析失败:", url, e);
    }

    return originalFetch.apply(this, arguments);
  };

  // ---------------------------------------------------------------- XHR 拦截
  const OriginalXHR = window.XMLHttpRequest;
  class StandaloneXHR extends OriginalXHR {
    constructor() {
      super();
      this._url = "";
      this._method = "GET";
    }

    open(method, url, async, user, password) {
      this._method = (method || "GET").toUpperCase();
      this._url = url;
      super.open(method, url, async !== false, user, password);
    }

    send(body) {
      try {
        const parsed = new URL(this._url, window.location.href);
        const routeKey = `${this._method} ${parsed.pathname}`;

        if (router.has(routeKey)) {
          const handler = router.get(routeKey);
          Promise.resolve(
            handler(new Request(this._url, { method: this._method, body }), parsed)
          )
            .then(async (res) => {
              const resText = await res.text();
              Object.defineProperty(this, "readyState", { value: 4, writable: false });
              Object.defineProperty(this, "status", { value: res.status, writable: false });
              Object.defineProperty(this, "statusText", { value: res.statusText, writable: false });
              Object.defineProperty(this, "responseText", { value: resText, writable: false });
              Object.defineProperty(this, "response", { value: resText, writable: false });

              this.dispatchEvent(new Event("readystatechange"));
              this.dispatchEvent(new Event("load"));
            })
            .catch(() => {
              this.dispatchEvent(new Event("error"));
            });
          return;
        }
      } catch (e) {
        // 走原生
      }

      super.send(body);
    }
  }

  window.XMLHttpRequest = StandaloneXHR;
  document.documentElement.dataset.standaloneHook = "installed";
  console.info("[Standalone Hook] 酒馆原生脱机网络拦截器安装完毕，准备启动原生 UI。");
})();
