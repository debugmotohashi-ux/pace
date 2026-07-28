(function (root) {
  "use strict";

  var SUPABASE_URL = "https://wsrkayiutdgiidtxpqgm.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_Dl0Nvph_kihEm5ynnmZCEw_NoKFU2lU";
  var WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
  var NEXUS_ORIGIN = "https://nexus-ver2.aile-01.chatgpt.site";
  var client = null;
  var session = null;
  var statusEl = null;

  function setStatus(message, tone) {
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.id = "nexusCloudStatus";
      statusEl.style.cssText =
        "position:fixed;right:10px;bottom:10px;z-index:90;padding:7px 10px;border-radius:999px;font:700 11px/1.2 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.16);";
      document.body.appendChild(statusEl);
    }
    statusEl.textContent = message;
    statusEl.style.background =
      tone === "ok" ? "#e8f7ef" : tone === "warn" ? "#fff4df" : "#eef2f7";
    statusEl.style.color =
      tone === "ok" ? "#176b3a" : tone === "warn" ? "#8a560f" : "#52606d";
  }

  function showLogin() {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(9,18,32,.72);padding:20px;backdrop-filter:blur(8px);";
      overlay.innerHTML =
        '<form style="width:min(420px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 24px 70px rgba(0,0,0,.28);font-family:system-ui,sans-serif">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:.12em;color:#2563eb">NEXUS DATABASE</div>' +
        '<h2 style="margin:8px 0 6px;font-size:21px;color:#172033">Nexusへログイン</h2>' +
        '<p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#667085">初回のみ、Nexusと同じメールアドレス・パスワードを入力してください。端末内データはログイン後にNexus DBへ同期します。</p>' +
        '<label style="display:block;margin-bottom:10px;font-size:11px;font-weight:700;color:#667085">メールアドレス<input name="email" type="email" autocomplete="username" required style="display:block;width:100%;margin-top:5px;padding:11px;border:1px solid #d9e1ec;border-radius:10px;font-size:14px"></label>' +
        '<label style="display:block;margin-bottom:10px;font-size:11px;font-weight:700;color:#667085">パスワード<input name="password" type="password" autocomplete="current-password" required style="display:block;width:100%;margin-top:5px;padding:11px;border:1px solid #d9e1ec;border-radius:10px;font-size:14px"></label>' +
        '<p data-error style="min-height:18px;margin:0 0 8px;color:#c0392b;font-size:12px"></p>' +
        '<button type="submit" style="width:100%;border:0;border-radius:11px;background:#2563eb;color:#fff;padding:12px;font-size:14px;font-weight:800">ログインして同期</button>' +
        '<button type="button" data-local style="width:100%;margin-top:8px;border:0;background:transparent;color:#7b8794;padding:8px;font-size:12px">今回は端末内データだけで開く</button>' +
        "</form>";
      document.body.appendChild(overlay);
      var form = overlay.querySelector("form");
      var errorEl = overlay.querySelector("[data-error]");
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var email = form.elements.email.value.trim();
        var password = form.elements.password.value;
        errorEl.textContent = "確認中…";
        client.auth
          .signInWithPassword({ email: email, password: password })
          .then(function (result) {
            if (result.error) throw result.error;
            session = result.data.session;
            overlay.remove();
            resolve(true);
          })
          .catch(function (error) {
            errorEl.textContent =
              error && error.message
                ? error.message
                : "ログインできませんでした。";
          });
      });
      overlay.querySelector("[data-local]").addEventListener("click", function () {
        overlay.remove();
        resolve(false);
      });
    });
  }

  function requestNexusSession() {
    if (root.parent === root) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      function finish(value) {
        if (settled) return;
        settled = true;
        root.removeEventListener("message", receive);
        if (timer) root.clearTimeout(timer);
        resolve(value);
      }
      function receive(event) {
        var data = event.data || {};
        if (
          event.origin !== NEXUS_ORIGIN ||
          data.type !== "NEXUS_SESSION" ||
          !data.accessToken ||
          !data.refreshToken
        ) {
          return;
        }
        client.auth
          .setSession({
            access_token: data.accessToken,
            refresh_token: data.refreshToken,
          })
          .then(function (result) {
            if (result.error) throw result.error;
            session = result.data.session;
            finish(Boolean(session));
          })
          .catch(function () {
            finish(false);
          });
      }
      root.addEventListener("message", receive);
      root.parent.postMessage({ type: "NEXUS_SESSION_REQUEST" }, NEXUS_ORIGIN);
      timer = root.setTimeout(function () {
        finish(false);
      }, 2500);
    });
  }

  async function connect(appCode) {
    if (!root.supabase || !root.supabase.createClient) {
      setStatus("端末内保存", "warn");
      return null;
    }
    if (!client) {
      client = root.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        },
      );
    }
    try {
      var result = await client.auth.getSession();
      session = result.data.session;
      if (!session) await requestNexusSession();
      if (!session && !(await showLogin())) {
        setStatus("端末内保存", "warn");
        return null;
      }
      setStatus("Nexus DB 接続済み", "ok");
      return {
        async load() {
          var result = await client
            .from("nexus_app_states")
            .select("state,updated_at")
            .eq("workspace_id", WORKSPACE_ID)
            .eq("app_code", appCode)
            .maybeSingle();
          if (result.error) throw result.error;
          return result.data;
        },
        async save(state) {
          if (!session) return;
          var result = await client.from("nexus_app_states").upsert(
            {
              workspace_id: WORKSPACE_ID,
              app_code: appCode,
              state: state,
              updated_by: session.user.id,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "workspace_id,app_code" },
          );
          if (result.error) throw result.error;
          setStatus("Nexus DB 同期済み", "ok");
        },
        setStatus: setStatus,
      };
    } catch (error) {
      console.error("Nexus cloud connection failed", error);
      setStatus("同期エラー・端末内保存", "warn");
      return null;
    }
  }

  root.NexusCloud = { connect: connect };
})(typeof window !== "undefined" ? window : globalThis);
