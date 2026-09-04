use std::mem::size_of;

// Windows API constants
const SPI_SETSTICKYKEYS: u32 = 0x003B;
const SPIF_SENDCHANGE: u32 = 0x0002;
const SKF_STICKYKEYSON: u32 = 0x0001;

#[repr(C)]
struct STICKYKEYS {
    cb_size: u32,
    dw_flags: u32,
}

#[link(name = "user32")]
extern "system" {
    fn SystemParametersInfoW(
        ui_action: u32,
        ui_param: u32,
        pv_param: *mut std::ffi::c_void,
        f_win_ini: u32,
    ) -> i32;
}

/// Enable or disable Windows Sticky Keys accessibility feature.
pub fn apply_sticky_keys(enabled: bool) -> Result<(), String> {
    let dw_flags: u32 = if enabled { SKF_STICKYKEYSON } else { 0 };

    let mut sticky_keys = STICKYKEYS {
        cb_size: size_of::<STICKYKEYS>() as u32,
        dw_flags,
    };

    let result = unsafe {
        SystemParametersInfoW(
            SPI_SETSTICKYKEYS,
            size_of::<STICKYKEYS>() as u32,
            &mut sticky_keys as *mut STICKYKEYS as *mut std::ffi::c_void,
            SPIF_SENDCHANGE,
        )
    };

    if result == 0 {
        let error = std::io::Error::last_os_error();
        Err(format!("SystemParametersInfoW(SPI_SETSTICKYKEYS) failed: {error}"))
    } else {
        Ok(())
    }
}
