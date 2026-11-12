import IBus from 'gi://IBus';
import {getIBusManager} from 'resource:///org/gnome/shell/misc/ibusManager.js';
import * as InputSourceManager from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const Event = Object.freeze({CHANGED: 'current-source-changed'});
const Fallback = Object.freeze({LAYOUT: 'us'});
const Hangul = Object.freeze({ENGINE: 'hangul', MODE: 'InputMode', LATIN: ['EN', '영문']});

export class Language {
    constructor() {
        this.manager = InputSourceManager.getInputSourceManager();
    }

    currentId() {
        if (this.isHangul())
            return Hangul.LATIN.includes(this._hangulMode()?.get_symbol()?.get_text()) ? 'us' : 'ko';
        return this.manager.currentSource?.xkbId || Fallback.LAYOUT;
    }

    isHangul() {
        return this.composing() && this.manager.currentSource.id === Hangul.ENGINE;
    }

    _hangulMode() {
        if (!this.isHangul())
            return null;
        const props = this.manager.currentSource.properties;
        for (let i = 0, prop; (prop = props?.get(i)); i++) {
            if (prop.get_key() === Hangul.MODE)
                return prop;
        }
        return null;
    }

    toggleHangul() {
        const mode = this._hangulMode();
        if (mode?.get_sensitive() && mode.get_visible()) {
            const state = this.currentId() === 'ko' ? IBus.PropState.UNCHECKED : IBus.PropState.CHECKED;
            getIBusManager().activateProperty(Hangul.MODE, state);
        }
    }

    composing() {
        return this.manager.currentSource?.type === InputSourceManager.INPUT_SOURCE_TYPE_IBUS;
    }

    connect(callback) {
        return this.manager.connect(Event.CHANGED, callback);
    }

    disconnect(id) {
        this.manager.disconnect(id);
    }
}
