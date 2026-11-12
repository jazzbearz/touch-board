import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GUdev from 'gi://GUdev';

export function defaultSeat() {
    const backend = Clutter.get_default_backend
        ? Clutter.get_default_backend()
        : global.stage.context.get_backend();
    return backend.get_default_seat();
}

export function hasPhysicalKeyboard(seat, udev) {
    return seat.list_devices().some(device => {
        if (!(device.get_capabilities() & Clutter.InputCapabilities.KEYBOARD))
            return false;
        const node = device.get_device_node();
        if (!node)
            return false;
        const input = udev.query_by_subsystem_and_name('input', Gio.File.new_for_path(node).get_basename());
        if (!input?.get_property_as_boolean('ID_INPUT_KEYBOARD'))
            return false;
        // Some detachable docks leave the legacy AT keyboard enumerated in tablet mode.
        const legacy = input.get_property('ID_PATH')?.startsWith('platform-i8042-');
        return !(legacy && seat.get_touch_mode());
    });
}

export function inputDevices() {
    return new GUdev.Client({subsystems: ['input']});
}
