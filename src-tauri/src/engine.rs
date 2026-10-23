use rquickjs::{function::Func, Context, Ctx, Exception, Function, Promise, Runtime};
use serde_json::{json, Value};

pub struct Engine {
    context: Context,
    _runtime: Runtime,
}
impl Engine {
    pub fn new(
        saved: Option<String>,
        fetch: impl Fn(String) -> Result<String, String> + 'static,
        save: impl Fn(String) -> Result<(), String> + 'static,
        emit: impl Fn(String) + 'static,
        notify: impl Fn(String) -> Result<(), String> + 'static,
    ) -> Result<Self, String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(128 * 1024 * 1024);
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        context.with(|ctx| -> Result<(), String> {
            let globals = ctx.globals();
            globals.set("nativeFetch", Func::from(move |ctx: Ctx<'_>, url: String| { fetch(url).map_err(|e| Exception::throw_message(&ctx, &e)) })).map_err(|e| e.to_string())?;
            globals.set("nativeSave", Func::from(move |ctx: Ctx<'_>, text: String| { save(text).map_err(|e| Exception::throw_message(&ctx, &e)) })).map_err(|e| e.to_string())?;
            globals.set("nativeEmit", Func::from(emit)).map_err(|e| e.to_string())?;
            globals.set("nativeNotify", Func::from(move |ctx: Ctx<'_>, text: String| { notify(text).map_err(|e| Exception::throw_message(&ctx, &e)) })).map_err(|e| e.to_string())?;
            globals.set("nativeURL", Func::from(|ctx: Ctx<'_>, text: String| {
                let url = url::Url::parse(&text).map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<String, rquickjs::Error>(json!({"protocol": format!("{}:", url.scheme()), "hostname": url.host_str(), "port": url.port().map(|p| p.to_string()).unwrap_or_default(), "username": url.username(), "password": url.password().unwrap_or_default(), "search": url.query().unwrap_or_default(), "hash": url.fragment().unwrap_or_default(), "origin": url.origin().ascii_serialization(), "pathname": url.path()}).to_string())
            })).map_err(|e| e.to_string())?;
            ctx.eval::<(), _>(include_str!("../../dist/backend/engine.js")).map_err(|e| js_error(&ctx, e))?;
            let init: Function = ctx.eval("surenecoEngine.init").map_err(|e| js_error(&ctx, e))?;
            init.call::<_, String>((saved, true, cfg!(target_os = "android"))).map_err(|e| js_error(&ctx, e))?;
            Ok(())
        })?;
        Ok(Self {
            context,
            _runtime: runtime,
        })
    }
    pub fn request(&self, command: &str, payload: Value) -> Result<Value, String> {
        self.context.with(|ctx| {
            let function: Function = ctx
                .eval("surenecoEngine.request")
                .map_err(|e| js_error(&ctx, e))?;
            let promise: Promise = function
                .call((json!({"command": command, "payload": payload}).to_string(),))
                .map_err(|e| js_error(&ctx, e))?;
            let result: String = promise.finish().map_err(|e| js_error(&ctx, e))?;
            serde_json::from_str(&result).map_err(|e| e.to_string())
        })
    }
    pub fn interval(&self) -> u64 {
        self.context.with(|ctx| {
            ctx.eval::<u64, _>("surenecoEngine.interval()")
                .unwrap_or(20)
        })
    }
}
fn js_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if error.is_exception() {
        let value = ctx.catch();
        if let Some(object) = value.as_object() {
            if let Ok(message) = object.get::<_, String>("message") {
                return message;
            }
        }
    }
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    #[test]
    fn actual_js_core_retains_detection_and_saved_settings() {
        let notifications = Rc::new(RefCell::new(Vec::new()));
        let received = notifications.clone();
        let persisted = Rc::new(RefCell::new(String::new()));
        let written = persisted.clone();
        let now = 1791471600;
        let id = now.to_string();
        let subject = format!("{id}.dat<>【雀魂】じゃんたま (1)");
        let engine = Engine::new(
            None,
            move |url| {
                Ok(if url.ends_with("subject.txt") {
                    subject.clone()
                } else {
                    "名無し<>sage<>2026/10/09(金) 00:00:00 ID:test<>Ⅲ東 ０１２３４<>タイトル".into()
                })
            },
            move |text| {
                *written.borrow_mut() = text;
                Ok(())
            },
            |_| {},
            move |text| {
                received.borrow_mut().push(text);
                Err("notification service unavailable".into())
            },
        )
        .unwrap();
        engine.context.with(|ctx| {
            ctx.eval::<(), _>("Date.now = () => new Date('2026-10-09T00:00:10+09:00').getTime()")
                .unwrap()
        });
        engine.request("refresh", json!({})).unwrap();
        let snapshot = engine.request("snapshot", json!({})).unwrap();
        assert_eq!(snapshot["threads"][0]["id"], id);
        engine
            .request("watch", json!({"id":id,"enabled":true}))
            .unwrap();
        assert!(persisted.borrow().contains(&id));
        let snapshot = engine.request("snapshot", json!({})).unwrap();
        assert_eq!(snapshot["recruitments"][0]["roomIds"][0], "01234");
        assert_eq!(notifications.borrow().len(), 1);
        assert_eq!(
            snapshot["errors"][0],
            "通知: notification service unavailable"
        );
        assert_eq!(
            engine
                .request("copy_room_id", json!({"id":"０１２３４"}))
                .unwrap(),
            "01234"
        );
        assert!(engine.request("copy_room_id", json!({"id":"bad"})).is_err());
        let mut settings = snapshot["settings"].clone();
        settings["update_sec"] = json!(35);
        engine
            .request("settings", json!({"settings": settings}))
            .unwrap();
        assert_eq!(engine.interval(), 35);
    }
    #[test]
    fn folder_cutover_keeps_live_state_and_restarts_with_subsequent_changes() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let target = root.path().join("selected");
        let storage = Rc::new(RefCell::new(
            crate::storage::ConfigStorage::load(base.clone()).unwrap(),
        ));
        let writer = storage.clone();
        let engine = Engine::new(
            None,
            |url| {
                Ok(if url.ends_with("subject.txt") {
                    "1791471600.dat<>【雀魂】じゃんたま (1)".into()
                } else {
                    "名無し<>sage<>2026/10/09(金) 00:00:00 ID:test<>Ⅲ東 ０１２３４<>タイトル".into()
                })
            },
            move |text| writer.borrow().save(&text),
            |_| {},
            |_| Ok(()),
        )
        .unwrap();
        engine.context.with(|ctx| {
            ctx.eval::<(), _>("Date.now = () => new Date('2026-10-09T00:00:10+09:00').getTime()")
                .unwrap();
        });
        engine
            .request("watch", json!({"id":"1791471600","enabled":true}))
            .unwrap();
        let old = storage.borrow().read().unwrap().unwrap();
        let saved = engine.request("saved_state", json!({})).unwrap();
        assert_eq!(saved["cursors"]["1791471600"], 1);
        storage
            .borrow_mut()
            .change(&target, &saved.to_string())
            .unwrap();
        let mut settings = saved["settings"].clone();
        settings["update_sec"] = json!(45);
        engine
            .request("settings", json!({"settings":settings}))
            .unwrap();
        assert_eq!(
            engine.request("snapshot", json!({})).unwrap()["recruitments"][0]["roomIds"][0],
            "01234"
        );
        assert_eq!(
            crate::storage::read(&base.join("state.json"))
                .unwrap()
                .unwrap(),
            old
        );
        let reopened = crate::storage::ConfigStorage::load(base).unwrap();
        let restarted = Engine::new(
            reopened.read().unwrap(),
            |_| Ok(String::new()),
            |_| Ok(()),
            |_| {},
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(restarted.interval(), 45);
        assert_eq!(
            restarted.request("saved_state", json!({})).unwrap()["cursors"]["1791471600"],
            1
        );
        assert_eq!(
            restarted.request("snapshot", json!({})).unwrap()["watched"],
            json!(["1791471600"])
        );
    }
    #[test]
    fn corrupt_saved_state_is_rejected() {
        assert!(Engine::new(
            Some("broken".into()),
            |_| Ok(String::new()),
            |_| Ok(()),
            |_| {},
            |_| Ok(())
        )
        .is_err());
    }
    #[test]
    fn failed_save_does_not_enable_watch() {
        let engine = Engine::new(
            None,
            |_| Ok(String::new()),
            |_| Err("disk full".into()),
            |_| {},
            |_| Ok(()),
        )
        .unwrap();
        assert!(engine
            .request("watch", json!({"id":"1786524360","enabled":true}))
            .unwrap_err()
            .contains("disk full"));
        assert_eq!(
            engine.request("snapshot", json!({})).unwrap()["watched"],
            json!([])
        );
    }

    #[test]
    fn failed_https_fetch_is_reported_and_can_be_retried() {
        let calls = std::cell::Cell::new(0);
        let engine = Engine::new(
            None,
            move |_| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Err("証明書検証に失敗しました。".into())
                } else {
                    Ok("1791471600.dat<>【雀魂】じゃんたま (1)".into())
                }
            },
            |_| Ok(()),
            |_| {},
            |_| Ok(()),
        )
        .unwrap();
        engine.context.with(|ctx| {
            ctx.eval::<(), _>("Date.now = () => new Date('2026-10-09T00:00:10+09:00').getTime()")
                .unwrap();
        });
        engine.request("refresh", json!({})).unwrap();
        let failed = engine.request("snapshot", json!({})).unwrap();
        assert_eq!(
            failed["errors"][0],
            "スレッド一覧: 証明書検証に失敗しました。"
        );
        engine.request("refresh", json!({})).unwrap();
        let recovered = engine.request("snapshot", json!({})).unwrap();
        assert_eq!(recovered["errors"], json!([]));
        assert_eq!(recovered["threads"][0]["id"], "1791471600");
    }
}
