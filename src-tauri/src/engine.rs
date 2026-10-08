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
            init.call::<_, String>((saved, true)).map_err(|e| js_error(&ctx, e))?;
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
}
