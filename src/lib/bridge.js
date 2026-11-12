import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {KeyboardManager} from 'resource:///org/gnome/shell/ui/keyboard.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getIBusManager} from 'resource:///org/gnome/shell/misc/ibusManager.js';
import {InputSourcePopup} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {Keyboard} from './keyboard.js';
import {Injector} from './injector.js';
import {Player} from './player.js';
import {Language} from './language.js';
import {Panel} from './panel.js';
import {defaultSeat, hasPhysicalKeyboard, inputDevices} from './seat.js';

const Signal = Object.freeze({
    ADDED: 'child-added',
    FOCUS: 'notify::key-focus',
    FOCUS_WINDOW: 'notify::focus-window',
    HEIGHT: 'notify::height',
    DISMISS: 'dismiss',
    MOVED: 'position-changed',
    MONITORS: 'monitors-changed',
    UNMANAGED: 'unmanaged',
    PANEL: 'input-panel-state',
    DEVICE: 'last-device-changed',
    DEVICE_ADDED: 'device-added',
    DEVICE_REMOVED: 'device-removed',
    TOUCH_MODE: 'notify::touch-mode',
    TOUCH: 'touch-event',
    SESSION: 'updated',
    TEXT: 'surrounding-text-set',
    CARET: 'cursor-location-changed',
    IBUS_CARET: 'set-cursor-location',
    IBUS_FOCUS_OUT: 'focus-out',
    ACCELERATOR: 'accelerator-activated',
    SOURCE: 'current-source-changed',
});

const Stock = Object.freeze({
    SYNC: '_syncEnabled',
    TOUCHSCREEN: '_lastDeviceIsTouchscreen',
    EVENT: 'maybeHandleEvent',
});

const A11y = Object.freeze({SCHEMA: 'org.gnome.desktop.a11y.applications', KEYBOARD: 'screen-keyboard-enabled'});

const State = Object.freeze({HIDDEN: 0, AUTO: 1, PINNED: 2});

const Indicator = Object.freeze({ROLE: 'touch-board'});

const Lift = Object.freeze({DURATION: 150});

const Edge = Object.freeze({HEIGHT: 12, DISTANCE: 48});
const ChatGPT = Object.freeze({DESKTOP_ID: 'chatgpt.desktop', WINDOW_CLASS: 'chatgpt'});

const Switch = Object.freeze({GRACE: 250});

const Property = Object.freeze({Y: 'y'});

const Direct = Object.freeze({CAPS: Clutter.InputCapabilities.TOUCH | Clutter.InputCapabilities.TABLET_TOOL});

function direct(device) {
    return (device.get_capabilities() & Direct.CAPS) !== 0;
}

export class Bridge {
    _settings;
    _panel = null;
    _injector = null;
    _player = null;
    _language = null;
    _keyboard;
    _box;
    _a11y = null;
    _injections = null;
    _state = State.HIDDEN;
    _direct = false;
    _armed = false;
    _accelerated = null;
    _switched = false;
    _switchId = 0;
    _sequences = new Map();
    _connections = [];
    _movedId = 0;
    _requestId = 0;
    _syncId = 0;
    _fitIndex = -1;
    _focusWindow = null;
    _movedWindow = null;
    _focusWindowStartY = null;
    _focusWindowOffset = 0;
    _easing = new Set();
    _caret = null;
    _caretAutoOpened = false;
    _keyboardAttached = false;
    _edgeSwipe = null;
    _edge = null;
    _edgeTouch = null;

    constructor(settings) {
        this._settings = settings;
    }

    _track(source, signal, callback) {
        const id = source.connect(signal, callback);
        this._connections.push({source, id});
        return id;
    }

    activate() {
        this._injector = new Injector();
        this._player = new Player(this._settings);
        this._language = new Language();
        this._keyboard = new Keyboard(this._injector, this._language, this._settings, this._player);
        this._keyboard.connect(Signal.DISMISS, () => this._hide());

        this._box = Main.layoutManager.keyboardBox;
        this._box.track_hover = false;
        this._box.add_child(this._keyboard);
        this._keyboard.hide();

        this._a11y = new Gio.Settings({schema_id: A11y.SCHEMA});
        this._injections = new InjectionManager();
        this._injections.overrideMethod(KeyboardManager.prototype, Stock.SYNC, () => function () {
            if (!this._keyboard)
                return;
            this._keyboard.close(true);
            this._keyboard.setCursorLocation(null);
            this._keyboard.destroy();
            this._keyboard = null;
        });
        this._injections.overrideMethod(KeyboardManager.prototype, Stock.TOUCHSCREEN, () => () => false);
        this._injections.overrideMethod(KeyboardManager.prototype, Stock.EVENT, () => event => this._forward(event));
        Main.keyboard._syncEnabled();
        const last = Main.keyboard._lastDevice;
        this._direct = last !== null && direct(last);

        this._edgeSwipe = Main.keyboard._bottomDragGesture ?? Main.keyboard._bottomDragAction;
        if (this._edgeSwipe)
            this._edgeSwipe.enabled = false;
        // Pick a Shell actor at touch-down so the window underneath never
        // receives the start of a sequence reserved for the keyboard.
        this._edge = new St.Widget({reactive: true, visible: false});
        Main.layoutManager.addTopChrome(this._edge);
        this._track(this._edge, Signal.TOUCH, (_actor, event) => this._onEdgeTouch(event));
        this._track(Main.sessionMode, Signal.SESSION, () => this._syncEdgeSwipe());

        this._track(this._box, Signal.ADDED, (_box, actor) => {
            if (actor !== this._keyboard)
                this._resync();
        });

        this._track(Main.inputMethod, Signal.PANEL, (_im, state) => this._onPanel(state));
        this._track(global.backend, Signal.DEVICE, (_backend, device) => this._onDevice(device));
        this._track(global.display, Signal.ACCELERATOR, (_display, _action, device) => this._onAccelerator(device));
        this._track(Main.inputMethod, Signal.TEXT, () => this._onText());
        this._track(this._language.manager, Signal.SOURCE, () => this._onSource());

        this._track(Main.layoutManager, Signal.MONITORS, () => this._onMonitorsChanged());

        this._track(this._keyboard, Signal.HEIGHT, () => {
            if (!this._lifted())
                return;
            this._positionKeyboard();
            this._evaluate();
        });

        this._track(global.display, Signal.FOCUS_WINDOW, () => this._onFocusWindow());

        this._track(Main.inputMethod, Signal.CARET, (_im, rect) => {
            this._onText();
            this._onCaret({
                x: rect.get_x(),
                y: rect.get_y(),
                width: rect.get_width(),
                height: rect.get_height(),
            });
        });

        const ibus = getIBusManager();
        this._track(ibus, Signal.IBUS_CARET, (_ibus, rect) => {
            if (Main.inputMethod.currentFocus)
                return;
            this._onText();
            this._onCaret(rect, true);
        });
        this._track(ibus, Signal.IBUS_FOCUS_OUT, () => {
            if (!Main.inputMethod.currentFocus)
                this._onInputBlur();
        });

        this._track(global.stage, Signal.FOCUS, () => this._evaluate());

        this._panel = new Panel(() => this._toggleKeyboard());
        Main.panel.addToStatusArea(Indicator.ROLE, this._panel);

        const seat = defaultSeat();
        const udev = inputDevices();
        const syncKeyboard = () => {
            this._keyboardAttached = hasPhysicalKeyboard(seat, udev);
            if (this._keyboardAttached && this._lifted())
                this._hide();
            this._syncEdgeSwipe();
        };
        this._track(seat, Signal.DEVICE_ADDED, syncKeyboard);
        this._track(seat, Signal.DEVICE_REMOVED, syncKeyboard);
        this._track(seat, Signal.TOUCH_MODE, syncKeyboard);
        syncKeyboard();
    }

    _resync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            Main.keyboard._syncEnabled();
            if (this._lifted())
                this._box.show();
            return GLib.SOURCE_REMOVE;
        });
    }

    _forward(event) {
        const actor = this._target(event);
        if (!this._lifted() || !actor || !(this._box.contains(actor) || this._keyboard.owns(actor)))
            return false;
        actor.event(event, true);
        actor.event(event, false);
        return true;
    }

    _target(event) {
        const actor = global.stage.get_event_actor(event);
        const sequence = event.get_event_sequence();
        if (!sequence)
            return actor;
        const slot = sequence.get_slot();
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            this._sequences.set(slot, actor);
            return actor;
        }
        const owner = this._sequences.get(slot) ?? actor;
        if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL)
            this._sequences.delete(slot);
        return owner;
    }

    _onPanel(state) {
        if (state === Clutter.InputPanelState.OFF) {
            this._onInputBlur();
        } else if (state === Clutter.InputPanelState.TOGGLE) {
            const event = Clutter.get_current_event();
            this._request(event !== null && direct(event.get_source_device()));
        } else if (!this._requestId) {
            this._requestId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._requestId = 0;
                this._request(this._direct);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _onInputBlur() {
        if (this._switched || this._switcher())
            return;
        this._caret = null;
        if (this._state === State.AUTO)
            this._hide();
        else
            this._evaluate();
        this._caretAutoOpened = false;
    }

    _request(tapped) {
        if (tapped || this._a11y.get_boolean(A11y.KEYBOARD))
            this._show(State.AUTO);
    }

    _onDevice(device) {
        if (direct(device)) {
            this._direct = true;
            this._armed = false;
        } else if (device.get_capabilities() & Clutter.InputCapabilities.KEYBOARD) {
            this._armed = device.get_device_node() !== null && device !== this._accelerated;
        } else {
            this._direct = false;
        }
        this._accelerated = null;
    }

    _onAccelerator(device) {
        this._armed = false;
        this._accelerated = device;
    }

    _switcher() {
        return global.stage.get_grab_actor() instanceof InputSourcePopup;
    }

    _onSource() {
        this._armed = false;
        if (!this._lifted())
            return;
        this._switched = true;
        if (this._switchId)
            GLib.source_remove(this._switchId);
        this._switchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Switch.GRACE, () => {
            this._switchId = 0;
            this._switched = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _onText() {
        if (this._switcher())
            return;
        if (this._armed && this._lifted())
            this._hide();
    }

    _toggleKeyboard() {
        if (this._state === State.HIDDEN)
            this._show(State.PINNED);
        else
            this._hide();
    }

    _onMonitorsChanged() {
        this._edgeTouch = null;
        this._syncEdgeSwipe();
        this._keyboard.refit();
        if (this._lifted()) {
            this._positionKeyboard();
            this._evaluate();
        }
    }

    _syncEdgeSwipe() {
        const monitor = Main.layoutManager.bottomMonitor;
        if (monitor) {
            this._edge.set_position(monitor.x, monitor.y + monitor.height - Edge.HEIGHT);
            this._edge.set_size(monitor.width, Edge.HEIGHT);
        }
        this._edge.visible = Boolean(monitor && !Main.sessionMode.isLocked &&
            !this._keyboardAttached && !this._lifted());
        if (!this._edge.visible)
            this._edgeTouch = null;
    }

    _onEdgeTouch(event) {
        const type = event.type();
        const slot = event.get_event_sequence().get_slot();
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            if (!this._edgeTouch) {
                const [x, y] = event.get_coords();
                this._edgeTouch = {slot, x, y};
            }
        } else if (this._edgeTouch?.slot === slot) {
            if (type === Clutter.EventType.TOUCH_CANCEL) {
                this._edgeTouch = null;
            } else if (type === Clutter.EventType.TOUCH_END) {
                const [x, y] = event.get_coords();
                const start = this._edgeTouch;
                this._edgeTouch = null;
                const rise = start.y - y;
                if (rise >= Edge.DISTANCE && rise > Math.abs(start.x - x))
                    this._show(State.PINNED, Main.layoutManager.bottomIndex);
            }
        }
        return Clutter.EVENT_STOP;
    }

    _show(state, monitor = Main.layoutManager.focusIndex) {
        if (this._keyboardAttached)
            return;
        if (this._state !== State.PINNED)
            this._state = state;
        this._armed = false;
        Main.layoutManager.keyboardIndex = monitor;
        this._box.show();
        if (this._fitIndex !== Main.layoutManager.keyboardIndex) {
            this._fitIndex = Main.layoutManager.keyboardIndex;
            if (this._keyboard.visible)
                this._keyboard.refit();
        }
        this._keyboard.show();
        this._positionKeyboard();
        this._evaluate();
        this._syncEdgeSwipe();
    }

    _hide() {
        this._state = State.HIDDEN;
        this._caretAutoOpened = true;
        this._setFocusWindow(null);
        this._keyboard.reset();
        this._keyboard.translation_y = 0;
        this._keyboard.hide();
        this._box.hide();
        this._syncEdgeSwipe();
    }

    _lifted() {
        return this._state !== State.HIDDEN;
    }

    _onFocusWindow() {
        this._caret = null;
        this._caretAutoOpened = false;
        this._evaluate();
    }

    _onCaret(rect, fromIBus = false) {
        const window = global.display.get_focus_window();
        const actor = window?.get_compositor_private();
        this._caret = null;
        if (actor && rect.height > 0) {
            // Convert the screen coordinates to a window-relative position
            // so moving the window doesn't change the required offset.
            const originY = fromIBus ? window.get_buffer_rect().y : actor.y;
            this._caret = {window, x: rect.x, y: rect.y - originY, height: rect.height};
            if (this._maybeOpenForCaret(window, rect))
                return;
        }
        this._evaluate();
    }

    _maybeOpenForCaret(window, rect) {
        if (this._lifted() || this._caretAutoOpened || this._keyboardAttached ||
            !this._direct || this._armed || global.stage.key_focus || this._switcher())
            return false;
        const frame = window.get_frame_rect();
        if (rect.x < frame.x || rect.x >= frame.x + frame.width ||
            rect.y >= frame.y + frame.height || rect.y + rect.height <= frame.y)
            return false;
        this._caretAutoOpened = true;
        this._show(State.AUTO, window.get_monitor());
        return true;
    }

    _evaluate() {
        if (!this._lifted()) {
            this._setFocusWindow(null);
            return;
        }
        const monitor = Main.layoutManager.keyboardMonitor;
        const window = global.display.get_focus_window();
        const caret = this._caret;
        const actor = window?.get_compositor_private();
        if (!actor || !monitor || global.stage.key_focus ||
            window.get_monitor() !== Main.layoutManager.keyboardIndex) {
            this._setFocusWindow(null);
            return;
        }
        const height = this._keyboard.height;
        if (height <= 0)
            return;
        const screenBottom = monitor.y + monitor.height;
        const originY = this._focusWindow === window ? this._focusWindowStartY : actor.y;
        let inputBottom = monitor.y;
        if (caret?.window === window) {
            const caretTop = originY + caret.y;
            if (caret.x >= monitor.x && caret.x < monitor.x + monitor.width && caretTop < screenBottom)
                inputBottom = caretTop + caret.height;
        } else if (this._isChatGPT(window)) {
            // The desktop app's composer is anchored at the window bottom.
            const frame = window.get_frame_rect();
            inputBottom = Math.min(screenBottom, frame.y + frame.height + originY - window.get_buffer_rect().y);
        }
        const offset = Math.max(0, Math.ceil(inputBottom - (screenBottom - height)));
        this._setFocusWindow(offset > 0 || this._focusWindow === window ? window : null, offset);
    }

    _isChatGPT(window) {
        return Shell.WindowTracker.get_default().get_window_app(window)?.get_id() === ChatGPT.DESKTOP_ID ||
            window.get_wm_class()?.toLowerCase() === ChatGPT.WINDOW_CLASS;
    }

    _setFocusWindow(window, offset = 0) {
        const actor = window ? window.get_compositor_private() : null;
        const target = actor ? window : null;
        if (this._focusWindow === target) {
            if (target && offset !== this._focusWindowOffset) {
                this._focusWindowOffset = offset;
                this._animateWindow(target, offset);
            }
            return;
        }
        if (this._focusWindow)
            this._animateWindow(this._focusWindow, 0, true);
        this._disconnectMoved();
        if (this._easing.has(actor))
            actor.remove_transition(Property.Y);
        this._focusWindowStartY = actor ? actor.y : null;
        this._focusWindow = target;
        this._focusWindowOffset = offset;
        if (target) {
            this._connectMoved(target);
            this._animateWindow(target, offset);
        }
    }

    _animateWindow(window, offset, restore = false) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;
        const finalY = this._focusWindowStartY - offset;
        if (actor.y === finalY && !actor.get_transition(Property.Y))
            return;
        let unmanaged = false;
        const unmanagedId = window.connect(Signal.UNMANAGED, () => {
            unmanaged = true;
        });
        actor.ease({
            y: finalY,
            duration: Lift.DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: isFinished => {
                window.disconnect(unmanagedId);
                this._easing.delete(actor);
                if (unmanaged || (!restore && !isFinished))
                    return;
                actor.y = finalY;
                this._sync(window, finalY);
            },
        });
        if (actor.get_transition(Property.Y))
            this._easing.add(actor);
    }

    _sync(window, finalY) {
        if (window.maximized_vertically || window.is_fullscreen())
            return;
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const y = finalY + (frame.y - buffer.y);
        const own = window === this._movedWindow;
        if (own)
            this._disconnectMoved();
        window.move_frame(true, frame.x, y);
        if (own && this._focusWindow === window)
            this._connectMoved(window);
    }

    _onMoved() {
        const actor = this._focusWindow?.get_compositor_private();
        actor?.remove_transition(Property.Y);
        this._disconnectMoved();
        this._caret = null;
        this._focusWindow = null;
        this._focusWindowStartY = null;
        this._focusWindowOffset = 0;
    }

    _connectMoved(window) {
        this._disconnectMoved();
        this._movedWindow = window;
        this._movedId = window.connect(Signal.MOVED, () => this._onMoved());
    }

    _disconnectMoved() {
        if (this._movedId && this._movedWindow)
            this._movedWindow.disconnect(this._movedId);
        this._movedId = 0;
        this._movedWindow = null;
    }

    _restoreLift() {
        for (const actor of this._easing)
            actor.remove_transition(Property.Y);
        const window = this._focusWindow;
        this._focusWindow = null;
        this._disconnectMoved();
        if (!window)
            return;
        const actor = window.get_compositor_private();
        if (actor) {
            actor.y = this._focusWindowStartY;
            this._sync(window, this._focusWindowStartY);
        }
        this._focusWindowStartY = null;
    }

    _positionKeyboard() {
        const h = this._keyboard.height;
        if (h > 0)
            this._keyboard.translation_y = -h;
    }

    deactivate() {
        this._panel.destroy();
        this._panel = null;
        if (this._requestId)
            GLib.source_remove(this._requestId);
        if (this._syncId)
            GLib.source_remove(this._syncId);
        if (this._switchId)
            GLib.source_remove(this._switchId);
        this._requestId = 0;
        this._syncId = 0;
        this._switchId = 0;
        for (const {source, id} of this._connections)
            source.disconnect(id);
        this._connections = [];
        this._edge.destroy();
        this._edge = null;
        this._edgeTouch = null;
        this._restoreLift();

        this._keyboard.release();
        this._box.remove_child(this._keyboard);
        this._keyboard.destroy();
        this._keyboard = null;
        this._injections.clear();
        this._injections = null;
        if (this._edgeSwipe)
            this._edgeSwipe.enabled = true;
        this._edgeSwipe = null;
        Main.keyboard._syncEnabled();
        this._box.visible = Boolean(Main.keyboard.visible);
        this._box.track_hover = true;
        this._a11y = null;
        this._accelerated = null;
        this._sequences.clear();

        this._language = null;
        this._injector.destroy();
        this._injector = null;
        this._player.destroy();
        this._player = null;
    }
}
