use iced::{
    widget::{button, container, text, text_editor, text_input, toggler},
    Border, Color, Theme,
};
use std::sync::LazyLock;

const fn rgb8(r: u8, g: u8, b: u8) -> Color {
    Color::from_rgb(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0)
}

struct Colors {
    background: Color,
    panel: Color,
    text: Color,
    muted: Color,
    border: Color,
    accent: Color,
    on_accent: Color,
    soft: Color,
    error_background: Color,
    error: Color,
    focus: Color,
}

const LIGHT: Colors = Colors {
    background: rgb8(245, 246, 248),
    panel: Color::WHITE,
    text: rgb8(32, 45, 56),
    muted: rgb8(82, 101, 116),
    border: rgb8(215, 223, 228),
    accent: rgb8(36, 101, 76),
    on_accent: Color::WHITE,
    soft: rgb8(232, 243, 237),
    error_background: rgb8(255, 241, 239),
    error: rgb8(153, 44, 35),
    focus: rgb8(38, 103, 189),
};

const DARK: Colors = Colors {
    background: rgb8(20, 26, 32),
    panel: rgb8(28, 36, 44),
    text: rgb8(228, 235, 241),
    muted: rgb8(159, 177, 190),
    border: rgb8(60, 77, 90),
    accent: rgb8(113, 211, 165),
    on_accent: rgb8(20, 26, 32),
    soft: rgb8(35, 65, 52),
    error_background: rgb8(67, 35, 38),
    error: rgb8(255, 164, 154),
    focus: rgb8(128, 181, 249),
};

fn colors(theme: &Theme) -> &'static Colors {
    if theme.extended_palette().is_dark {
        &DARK
    } else {
        &LIGHT
    }
}

pub fn theme(dark_mode: bool) -> Theme {
    fn create(name: &str, colors: &Colors) -> Theme {
        Theme::custom(
            name.into(),
            iced::theme::Palette {
                background: colors.background,
                text: colors.text,
                primary: colors.accent,
                success: colors.accent,
                danger: colors.error,
            },
        )
    }
    static LIGHT_THEME: LazyLock<Theme> = LazyLock::new(|| create("Sureneco Light", &LIGHT));
    static DARK_THEME: LazyLock<Theme> = LazyLock::new(|| create("Sureneco Dark", &DARK));
    if dark_mode {
        DARK_THEME.clone()
    } else {
        LIGHT_THEME.clone()
    }
}

pub fn panel(theme: &Theme) -> container::Style {
    let colors = colors(theme);
    container::Style {
        background: Some(colors.panel.into()),
        text_color: Some(colors.text),
        border: Border {
            color: colors.border,
            width: 1.0,
            radius: 12.0.into(),
        },
        ..Default::default()
    }
}

pub fn brand(theme: &Theme) -> container::Style {
    let colors = colors(theme);
    container::Style {
        background: Some(colors.accent.into()),
        text_color: Some(colors.on_accent),
        border: Border {
            radius: 10.0.into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

pub fn muted(theme: &Theme) -> text::Style {
    text::Style {
        color: Some(colors(theme).muted),
    }
}

pub fn secondary(theme: &Theme, status: button::Status) -> button::Style {
    let colors = colors(theme);
    button::Style {
        background: Some(
            if status == button::Status::Hovered {
                colors.soft
            } else {
                colors.panel
            }
            .into(),
        ),
        text_color: if status == button::Status::Disabled {
            colors.muted
        } else {
            colors.text
        },
        border: Border {
            color: colors.border,
            width: 1.0,
            radius: 8.0.into(),
        },
        ..Default::default()
    }
}

pub fn primary(theme: &Theme, status: button::Status) -> button::Style {
    let colors = colors(theme);
    let disabled = status == button::Status::Disabled;
    button::Style {
        background: Some(if disabled { colors.soft } else { colors.accent }.into()),
        text_color: if disabled {
            colors.muted
        } else {
            colors.on_accent
        },
        border: Border {
            color: if disabled {
                colors.border
            } else {
                colors.accent
            },
            width: 1.0,
            radius: 8.0.into(),
        },
        ..Default::default()
    }
}

pub fn tab(theme: &Theme, status: button::Status) -> button::Style {
    let colors = colors(theme);
    button::Style {
        background: (status == button::Status::Hovered).then_some(colors.soft.into()),
        text_color: colors.muted,
        ..Default::default()
    }
}

pub fn active_tab(theme: &Theme, status: button::Status) -> button::Style {
    button::Style {
        text_color: colors(theme).accent,
        ..tab(theme, status)
    }
}

pub fn badge(theme: &Theme) -> container::Style {
    let colors = colors(theme);
    container::Style {
        background: Some(colors.soft.into()),
        text_color: Some(colors.accent),
        border: Border {
            radius: 5.0.into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

pub fn closed_badge(theme: &Theme) -> container::Style {
    let colors = colors(theme);
    container::Style {
        background: Some(colors.error_background.into()),
        text_color: Some(colors.error),
        border: Border {
            radius: 5.0.into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn input_border(colors: &Colors, focused: bool) -> Border {
    Border {
        color: if focused { colors.focus } else { colors.border },
        width: if focused { 2.0 } else { 1.0 },
        radius: 7.0.into(),
    }
}

pub fn input(theme: &Theme, status: text_input::Status) -> text_input::Style {
    let colors = colors(theme);
    text_input::Style {
        background: colors.background.into(),
        border: input_border(colors, status == text_input::Status::Focused),
        value: colors.text,
        placeholder: colors.muted,
        selection: colors.soft,
        ..text_input::default(theme, status)
    }
}

pub fn editor(theme: &Theme, status: text_editor::Status) -> text_editor::Style {
    let colors = colors(theme);
    text_editor::Style {
        background: colors.background.into(),
        border: input_border(colors, status == text_editor::Status::Focused),
        value: colors.text,
        placeholder: colors.muted,
        selection: colors.soft,
        ..text_editor::default(theme, status)
    }
}

pub fn switch(theme: &Theme, status: toggler::Status) -> toggler::Style {
    let colors = colors(theme);
    let background = match status {
        toggler::Status::Active { is_toggled } | toggler::Status::Hovered { is_toggled } => {
            if is_toggled {
                colors.accent
            } else {
                colors.muted
            }
        }
        toggler::Status::Disabled => colors.border,
    };
    toggler::Style {
        background,
        foreground: colors.on_accent,
        ..toggler::default(theme, status)
    }
}
