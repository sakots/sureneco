use iced::{
    widget::{button, container, text, text_editor, text_input, toggler},
    Border, Color, Theme,
};
use std::sync::LazyLock;

const fn rgb8(r: u8, g: u8, b: u8) -> Color {
    Color::from_rgb(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0)
}

pub const BG: Color = rgb8(245, 246, 248);
pub const PANEL: Color = Color::WHITE;
pub const TEXT: Color = rgb8(32, 45, 56);
pub const MUTED: Color = rgb8(82, 101, 116);
pub const BORDER: Color = rgb8(215, 223, 228);
pub const ACCENT: Color = rgb8(36, 101, 76);
pub const SOFT: Color = rgb8(232, 243, 237);
pub const ERROR_BG: Color = rgb8(255, 241, 239);
pub const ERROR: Color = rgb8(153, 44, 35);
const FOCUS: Color = rgb8(38, 103, 189);
pub fn theme() -> Theme {
    static THEME: LazyLock<Theme> = LazyLock::new(|| {
        Theme::custom(
            "Sureneco".into(),
            iced::theme::Palette {
                background: BG,
                text: TEXT,
                primary: ACCENT,
                success: ACCENT,
                danger: ERROR,
            },
        )
    });
    THEME.clone()
}

pub fn panel(_: &Theme) -> container::Style {
    container::Style {
        background: Some(PANEL.into()),
        text_color: Some(TEXT),
        border: Border {
            color: BORDER,
            width: 1.0,
            radius: 12.0.into(),
        },
        ..Default::default()
    }
}

pub fn muted(_: &Theme) -> text::Style {
    text::Style { color: Some(MUTED) }
}

pub fn secondary(_: &Theme, status: button::Status) -> button::Style {
    button::Style {
        background: Some(
            if status == button::Status::Hovered {
                SOFT
            } else {
                PANEL
            }
            .into(),
        ),
        text_color: if status == button::Status::Disabled {
            MUTED
        } else {
            TEXT
        },
        border: Border {
            color: BORDER,
            width: 1.0,
            radius: 8.0.into(),
        },
        ..Default::default()
    }
}

pub fn primary(_: &Theme, status: button::Status) -> button::Style {
    let disabled = status == button::Status::Disabled;
    button::Style {
        background: Some(if disabled { SOFT } else { ACCENT }.into()),
        text_color: if disabled { MUTED } else { Color::WHITE },
        border: Border {
            color: if disabled { BORDER } else { ACCENT },
            width: 1.0,
            radius: 8.0.into(),
        },
        ..Default::default()
    }
}

pub fn tab(_: &Theme, status: button::Status) -> button::Style {
    button::Style {
        background: (status == button::Status::Hovered).then_some(SOFT.into()),
        text_color: MUTED,
        ..Default::default()
    }
}

pub fn active_tab(theme: &Theme, status: button::Status) -> button::Style {
    button::Style {
        text_color: ACCENT,
        ..tab(theme, status)
    }
}

pub fn badge(_: &Theme) -> container::Style {
    container::Style {
        background: Some(SOFT.into()),
        text_color: Some(ACCENT),
        border: Border {
            radius: 5.0.into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

pub fn closed_badge(_: &Theme) -> container::Style {
    container::Style {
        background: Some(ERROR_BG.into()),
        text_color: Some(ERROR),
        border: Border {
            radius: 5.0.into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn input_border(focused: bool) -> Border {
    Border {
        color: if focused { FOCUS } else { BORDER },
        width: if focused { 2.0 } else { 1.0 },
        radius: 7.0.into(),
    }
}

pub fn input(theme: &Theme, status: text_input::Status) -> text_input::Style {
    text_input::Style {
        background: BG.into(),
        border: input_border(status == text_input::Status::Focused),
        value: TEXT,
        placeholder: MUTED,
        selection: SOFT,
        ..text_input::default(theme, status)
    }
}

pub fn editor(theme: &Theme, status: text_editor::Status) -> text_editor::Style {
    text_editor::Style {
        background: BG.into(),
        border: input_border(status == text_editor::Status::Focused),
        value: TEXT,
        placeholder: MUTED,
        selection: SOFT,
        ..text_editor::default(theme, status)
    }
}

pub fn switch(theme: &Theme, status: toggler::Status) -> toggler::Style {
    let background = match status {
        toggler::Status::Active { is_toggled } | toggler::Status::Hovered { is_toggled } => {
            if is_toggled {
                ACCENT
            } else {
                MUTED
            }
        }
        toggler::Status::Disabled => BORDER,
    };
    toggler::Style {
        background,
        foreground: Color::WHITE,
        ..toggler::default(theme, status)
    }
}
