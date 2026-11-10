//! Let ProMotion displays set the page cadence instead of WebKit's 60 fps preference.

/** Exact feature matching keeps this optional compatibility tweak away from other preferences. */
fn is_cadence_preference(key: &str) -> bool { key == "PreferPageRenderingUpdatesNear60FPSEnabled" }

pub fn configure(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    let _ = window.with_webview(|webview| unsafe { macos::configure(webview.inner(), webview.ns_window()); });
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void, CStr};
    type Object = *mut c_void;
    type Selector = *mut c_void;
    type Imp = unsafe extern "C" fn();

    #[link(name = "objc")]
    extern "C" {
        fn object_getClass(object: Object) -> Object;
        fn sel_registerName(name: *const c_char) -> Selector;
        fn class_getInstanceMethod(class: Object, selector: Selector) -> Object;
        fn method_getImplementation(method: Object) -> Imp;
    }

    /** Lookup before every call: removed private selectors must be a silent no-op. */
    unsafe fn method(object: Object, name: &CStr) -> Option<(Imp, Selector)> {
        if object.is_null() { return None; }
        let selector = sel_registerName(name.as_ptr());
        let method = class_getInstanceMethod(object_getClass(object), selector);
        if method.is_null() { None } else { Some((method_getImplementation(method), selector)) }
    }

    unsafe fn object(receiver: Object, name: &CStr) -> Option<Object> {
        let (imp, selector) = method(receiver, name)?;
        let call: unsafe extern "C" fn(Object, Selector) -> Object = std::mem::transmute(imp);
        let value = call(receiver, selector);
        (!value.is_null()).then_some(value)
    }

    unsafe fn number(receiver: Object, name: &CStr) -> Option<usize> {
        let (imp, selector) = method(receiver, name)?;
        let call: unsafe extern "C" fn(Object, Selector) -> usize = std::mem::transmute(imp);
        Some(call(receiver, selector))
    }

    /** Runs on Tauri's main thread; all objects are borrowed for the duration of the callback. */
    pub unsafe fn configure(view: Object, window: Object) -> Option<()> {
        let screen = object(window, c"screen")?;
        if number(screen, c"maximumFramesPerSecond")? <= 60 { return None; }
        let config = object(view, c"configuration")?;
        let preferences = object(config, c"preferences")?;
        let features = object(object_getClass(preferences), c"_features")?;
        let count = number(features, c"count")?.min(2048);
        let (get, get_selector) = method(features, c"objectAtIndex:")?;
        let get: unsafe extern "C" fn(Object, Selector, usize) -> Object = std::mem::transmute(get);
        let (set, set_selector) = method(preferences, c"_setEnabled:forFeature:")?;
        let set: unsafe extern "C" fn(Object, Selector, i8, Object) = std::mem::transmute(set);
        for index in 0..count {
            let feature = get(features, get_selector, index);
            let Some(key) = object(feature, c"key") else { continue; };
            let Some((utf8, selector)) = method(key, c"UTF8String") else { continue; };
            let utf8: unsafe extern "C" fn(Object, Selector) -> *const c_char = std::mem::transmute(utf8);
            let chars = utf8(key, selector);
            if !chars.is_null() && CStr::from_ptr(chars).to_str().is_ok_and(super::is_cadence_preference) {
                set(preferences, set_selector, 0, feature);
                return Some(());
            }
        }
        None
    }
}
