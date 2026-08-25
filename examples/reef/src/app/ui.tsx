/** Shared primitives — every style is StyleX, themed by the token vars. */

import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { colors, radii, space, type } from "./theme/tokens.stylex";

// ── icons ────────────────────────────────────────────────────────────────────

const ICON_PATHS = {
  plus: "M12 5v14M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  chevronLeft: "m15 18-6-6 6-6",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 18 6-6-6-6",
  arrowRight: "M5 12h14m-7-7 7 7-7 7",
  sun: "M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  history: "M3 12a9 9 0 1 0 2.64-6.36M3 3v5h5m4-1v5l3 2",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z",
  trash: "M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 5v6m4-6v6",
  send: "M22 2 11 13m11-11-7 20-4-9-9-4 20-7z",
  userPlus: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm10-3v6m3-3h-6",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9",
  alert: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 6v4m0 4h.01",
  info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 14v-4m0-4h.01",
  sparkles: "m12 3 1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3zM19 3v3m-1.5-1.5h3M5 17v2m-1-1h2",
  database: "M12 2c5 0 9 1.34 9 3s-4 3-9 3-9-1.34-9-3 4-3 9-3zM3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4 3 9 3s9-1.34 9-3",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
} as const;

export type IconName = keyof typeof ICON_PATHS;

const iconStyles = stylex.create({
  svg: { display: "inline-block", flexShrink: 0, verticalAlign: "-0.125em" },
});

export const Icon = ({
  name,
  size = 16,
  strokeWidth = 2,
  ...rest
}: { name: IconName; size?: number; strokeWidth?: number } & Omit<
  React.SVGProps<SVGSVGElement>,
  "name"
>) => (
  <svg
    {...rest}
    {...stylex.props(iconStyles.svg)}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={ICON_PATHS[name]} />
  </svg>
);

// ── brand ────────────────────────────────────────────────────────────────────

const logoStyles = stylex.create({
  mark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    backgroundImage: "linear-gradient(135deg, #5b8cff 0%, #2dd4bf 100%)",
    boxShadow: "0 4px 14px rgba(91, 140, 255, 0.35)",
    color: "#fff",
    flexShrink: 0,
  },
  wordmark: {
    fontWeight: 800,
    letterSpacing: "-0.03em",
    color: colors.text,
    lineHeight: 1,
  },
  lockup: { display: "inline-flex", alignItems: "center", gap: space.sm },
});

/** The Reef mark: a rounded gradient tile with a wave. */
export const LogoMark = ({ size = 28 }: { size?: number }) => (
  <span {...stylex.props(logoStyles.mark)} style={{ width: size, height: size }}>
    <svg
      width={size * 0.62}
      height={size * 0.62}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 8c2.5 0 2.5 2.5 5 2.5S9.5 8 12 8s2.5 2.5 5 2.5S19.5 8 22 8" />
      <path d="M2 15c2.5 0 2.5 2.5 5 2.5s2.5-2.5 5-2.5 2.5 2.5 5 2.5 2.5-2.5 5-2.5" />
    </svg>
  </span>
);

export const Logo = ({ size = 28 }: { size?: number }) => (
  <span {...stylex.props(logoStyles.lockup)}>
    <LogoMark size={size} />
    <span {...stylex.props(logoStyles.wordmark)} style={{ fontSize: size * 0.72 }}>
      Reef
    </span>
  </span>
);

// ── button ───────────────────────────────────────────────────────────────────

const button = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radii.sm,
    paddingBlock: "6px",
    paddingInline: space.md,
    fontSize: type.sm,
    fontWeight: 600,
    lineHeight: 1.3,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.45 },
    transition:
      "background-color 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease, transform 80ms ease",
    whiteSpace: "nowrap",
    userSelect: "none",
    outline: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 3px ${colors.ring}` },
    transform: { default: "none", ":active": "translateY(0.5px)" },
    backgroundImage: "none",
  },
  primary: {
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    color: colors.accentText,
    boxShadow: {
      default: "inset 0 1px 0 rgba(255,255,255,0.14)",
      ":focus-visible": `inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 3px ${colors.ring}`,
    },
  },
  ghost: {
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    borderColor: { default: colors.border, ":hover": colors.borderStrong },
    color: colors.text,
  },
  subtle: {
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.textMuted, ":hover": colors.text },
  },
  sm: {
    paddingBlock: "3px",
    paddingInline: space.sm,
    fontSize: type.xs,
    borderRadius: radii.xs,
  },
  icon: {
    paddingBlock: 0,
    paddingInline: 0,
    width: "28px",
    height: "28px",
    borderRadius: radii.sm,
  },
  iconSm: { width: "24px", height: "24px" },
  iconDanger: {
    color: { default: colors.textMuted, ":hover": colors.danger },
    backgroundColor: { default: "transparent", ":hover": colors.dangerSoft },
  },
});

export const Button = ({
  variant = "ghost",
  size,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "subtle";
  size?: "sm";
}) => (
  <button
    type="button"
    {...props}
    {...stylex.props(button.base, button[variant], size === "sm" && button.sm)}
  />
);

/** A square, icon-only button. `label` is the accessible name (and tooltip). */
export const IconButton = ({
  icon,
  label,
  size,
  tone = "subtle",
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: IconName;
  label: string;
  size?: "sm";
  tone?: "subtle" | "danger";
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    {...props}
    {...stylex.props(
      button.base,
      button.subtle,
      button.icon,
      size === "sm" && button.iconSm,
      tone === "danger" && button.iconDanger,
    )}
  >
    <Icon name={icon} size={size === "sm" ? 14 : 16} />
  </button>
);

// ── inputs ───────────────────────────────────────────────────────────────────

const field = stylex.create({
  base: {
    width: "100%",
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: colors.border,
      ":hover": colors.borderStrong,
      ":focus": colors.accent,
    },
    borderRadius: radii.sm,
    paddingBlock: "7px",
    paddingInline: space.md,
    fontSize: type.md,
    color: colors.text,
    outline: "none",
    boxShadow: { default: "none", ":focus": `0 0 0 3px ${colors.ring}` },
    transition: "border-color 120ms ease, box-shadow 120ms ease",
    "::placeholder": { color: colors.textFaint },
  },
  textarea: {
    resize: "vertical",
    minHeight: "72px",
    fontFamily: type.family,
    lineHeight: 1.5,
  },
  select: {
    appearance: "none",
    paddingRight: "30px",
    cursor: "pointer",
  },
  selectWrap: { position: "relative", width: "100%" },
  selectChevron: {
    position: "absolute",
    right: "10px",
    top: "50%",
    transform: "translateY(-50%)",
    pointerEvents: "none",
    color: colors.textMuted,
    display: "inline-flex",
  },
  label: {
    display: "block",
    fontSize: type.xs,
    fontWeight: 600,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: colors.textMuted,
    marginBottom: "6px",
  },
  group: { marginBottom: space.lg },
});

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div {...stylex.props(field.group)}>
    <label {...stylex.props(field.label)}>{label}</label>
    {children}
  </div>
);

export const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} {...stylex.props(field.base)} />
);

export const TextArea = (
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) => <textarea {...props} {...stylex.props(field.base, field.textarea)} />;

export const Select = (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <span {...stylex.props(field.selectWrap)}>
    <select {...props} {...stylex.props(field.base, field.select)} />
    <span {...stylex.props(field.selectChevron)}>
      <Icon name="chevronDown" size={14} />
    </span>
  </span>
);

// ── dialog ───────────────────────────────────────────────────────────────────

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const riseIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(10px) scale(0.98)" },
  to: { opacity: 1, transform: "translateY(0) scale(1)" },
});

const dialog = stylex.create({
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: colors.overlay,
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "12vh",
    paddingInline: space.lg,
    zIndex: 50,
    animationName: fadeIn,
    animationDuration: "140ms",
    animationTimingFunction: "ease-out",
  },
  panel: {
    width: "min(480px, 100%)",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    boxShadow: colors.shadow,
    padding: space.xl,
    animationName: riseIn,
    animationDuration: "180ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    color: colors.text,
    fontFamily: type.family,
    fontSize: type.md,
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.lg,
  },
  title: {
    margin: 0,
    fontSize: type.lg,
    fontWeight: 700,
    color: colors.text,
    flexGrow: 1,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.sm,
    marginTop: space.xl,
  },
});

export const Dialog = ({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) =>
  createPortal(
    <div
      {...stylex.props(dialog.overlay)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        {...stylex.props(dialog.panel)}
        role="dialog"
        aria-label={typeof title === "string" ? title : undefined}
      >
        <div {...stylex.props(dialog.head)}>
          <h2 {...stylex.props(dialog.title)}>{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );

export const DialogFooter = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(dialog.footer)}>{children}</div>
);

// ── badges, tags & avatars ───────────────────────────────────────────────────

const badge = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    borderRadius: radii.full,
    paddingBlock: "1px",
    paddingInline: "8px",
    fontSize: type.xs,
    fontWeight: 600,
    lineHeight: 1.7,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    whiteSpace: "nowrap",
  },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: radii.full,
    flexShrink: 0,
  },
  toggle: {
    cursor: "pointer",
    outline: "none",
    transition: "background-color 120ms ease, border-color 120ms ease, color 120ms ease",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 3px ${colors.ring}` },
    backgroundImage: "none",
  },
  toggleOff: {
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    borderColor: colors.border,
    color: colors.textMuted,
  },
});

/** Data-driven color, so the swatch itself is an inline style. */
export const LabelBadge = ({ name, color }: { name: string; color: string }) => (
  <span
    {...stylex.props(badge.base)}
    style={{ backgroundColor: `${color}1f`, color, borderColor: `${color}33` }}
  >
    <span {...stylex.props(badge.dot)} style={{ backgroundColor: color }} />
    {name}
  </span>
);

/** A label as an on/off toggle (the detail panel's label picker). */
export const LabelToggle = ({
  name,
  color,
  on,
  onToggle,
}: {
  name: string;
  color: string;
  on: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    aria-pressed={on}
    title={on ? `Remove ${name}` : `Add ${name}`}
    onClick={onToggle}
    {...stylex.props(badge.base, badge.toggle, !on && badge.toggleOff)}
    style={
      on
        ? { backgroundColor: `${color}1f`, color, borderColor: `${color}55` }
        : undefined
    }
  >
    <span
      {...stylex.props(badge.dot)}
      style={{ backgroundColor: color, opacity: on ? 1 : 0.55 }}
    />
    {name}
    {on && <Icon name="check" size={11} strokeWidth={3} />}
  </button>
);

const tag = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: type.xs,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    borderRadius: radii.full,
    paddingBlock: "2px",
    paddingInline: "8px",
    lineHeight: 1.5,
    whiteSpace: "nowrap",
  },
  accent: { backgroundColor: colors.accentSoft, color: colors.accent },
  neutral: { backgroundColor: colors.surfaceActive, color: colors.textMuted },
  ok: { backgroundColor: colors.okSoft, color: colors.ok },
  warn: { backgroundColor: colors.warnSoft, color: colors.warn },
  danger: { backgroundColor: colors.dangerSoft, color: colors.danger },
});

export const Tag = ({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "accent" | "neutral" | "ok" | "warn" | "danger";
  children: ReactNode;
  title?: string;
}) => (
  <span {...stylex.props(tag.base, tag[tone])} title={title}>
    {children}
  </span>
);

const AVATAR_HUES = [212, 262, 152, 22, 330, 190, 52];

/** Stable per-name hue, shared by avatars and workspace tiles. */
export const hueOf = (name: string): number => {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length]!;
};

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

const avatar = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.full,
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
    letterSpacing: "0.02em",
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)",
  },
});

const AVATAR_SIZES = { sm: [22, 10], md: [28, 12] } as const;

export const Avatar = ({
  name,
  title,
  size = "sm",
}: {
  name: string;
  title?: string;
  size?: keyof typeof AVATAR_SIZES;
}) => {
  const [px, font] = AVATAR_SIZES[size];
  return (
    <span
      {...stylex.props(avatar.base)}
      title={title ?? name}
      style={{
        width: px,
        height: px,
        fontSize: font,
        backgroundColor: `hsl(${hueOf(name)} 46% 46%)`,
      }}
    >
      {initialsOf(name)}
    </span>
  );
};

// ── priority ─────────────────────────────────────────────────────────────────

const PRIORITY_TINTS = [
  "#6b7588",
  "#8b93a3",
  "#5b8cff",
  "#f5a524",
  "#ef5f6b",
] as const;

const priorityStyles = stylex.create({
  svg: { display: "inline-block", flexShrink: 0, verticalAlign: "middle" },
});

/**
 * Linear-style priority glyph: three rising bars filled to the level, a
 * filled "!" square for urgent, faint dashes for none.
 */
export const PriorityIcon = ({
  level,
  size = 16,
  title,
}: {
  level: number;
  size?: number;
  title?: string;
}) => {
  const tint = PRIORITY_TINTS[level] ?? PRIORITY_TINTS[0];
  if (level >= 4) {
    return (
      <svg
        {...stylex.props(priorityStyles.svg)}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        aria-label={title}
      >
        {title && <title>{title}</title>}
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill={tint} />
        <path
          d="M8 4.5v4.2M8 11.4v.1"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  const bars = [
    { x: 2, h: 5 },
    { x: 6.5, h: 8.5 },
    { x: 11, h: 12 },
  ];
  return (
    <svg
      {...stylex.props(priorityStyles.svg)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {bars.map((b, i) => (
        <rect
          key={b.x}
          x={b.x}
          y={14 - b.h}
          width="3"
          height={b.h}
          rx="1"
          fill={tint}
          opacity={level === 0 ? 0.28 : i < level ? 1 : 0.22}
        />
      ))}
    </svg>
  );
};

// ── toasts ───────────────────────────────────────────────────────────────────

interface Toast {
  readonly id: number;
  readonly kind: "info" | "error" | "success";
  readonly message: string;
}

const ToastContext = createContext<(kind: Toast["kind"], message: string) => void>(
  () => {},
);

export const useToast = () => useContext(ToastContext);

const toastIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(12px)" },
  to: { opacity: 1, transform: "translateY(0)" },
});

const toastStyles = stylex.create({
  stack: {
    position: "fixed",
    bottom: space.xl,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    zIndex: 100,
    alignItems: "center",
    fontFamily: type.family,
  },
  toast: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    boxShadow: colors.shadow,
    paddingBlock: "10px",
    paddingInline: space.lg,
    fontSize: type.sm,
    fontWeight: 500,
    color: colors.text,
    maxWidth: "min(520px, calc(100vw - 32px))",
    animationName: toastIn,
    animationDuration: "180ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  },
  iconWrap: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    borderRadius: radii.full,
    flexShrink: 0,
  },
  info: { backgroundColor: colors.accentSoft, color: colors.accent },
  success: { backgroundColor: colors.okSoft, color: colors.ok },
  error: { backgroundColor: colors.dangerSoft, color: colors.danger },
  errorText: { color: colors.danger },
});

const TOAST_ICON: Record<Toast["kind"], IconName> = {
  info: "info",
  success: "check",
  error: "alert",
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((kind: Toast["kind"], message: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          <div {...stylex.props(toastStyles.stack)}>
            {toasts.map((t) => (
              <div
                key={t.id}
                role="status"
                {...stylex.props(toastStyles.toast, t.kind === "error" && toastStyles.errorText)}
              >
                <span {...stylex.props(toastStyles.iconWrap, toastStyles[t.kind])}>
                  <Icon name={TOAST_ICON[t.kind]} size={13} strokeWidth={2.5} />
                </span>
                {t.message}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
};

// ── empty state ──────────────────────────────────────────────────────────────

const emptyStyles = stylex.create({
  box: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: space.sm,
    padding: space.xl,
  },
  icon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "44px",
    height: "44px",
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    marginBottom: space.xs,
  },
  title: { margin: 0, fontSize: type.md, fontWeight: 700, color: colors.text },
  hint: {
    margin: 0,
    fontSize: type.sm,
    color: colors.textMuted,
    lineHeight: 1.5,
    maxWidth: "36ch",
  },
  actions: { display: "flex", gap: space.sm, marginTop: space.sm, flexWrap: "wrap", justifyContent: "center" },
});

export const Empty = ({
  icon,
  title,
  hint,
  actions,
}: {
  icon: IconName;
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
}) => (
  <div {...stylex.props(emptyStyles.box)}>
    <span {...stylex.props(emptyStyles.icon)}>
      <Icon name={icon} size={20} />
    </span>
    <p {...stylex.props(emptyStyles.title)}>{title}</p>
    {hint && <p {...stylex.props(emptyStyles.hint)}>{hint}</p>}
    {actions && <div {...stylex.props(emptyStyles.actions)}>{actions}</div>}
  </div>
);

// ── misc ─────────────────────────────────────────────────────────────────────

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const misc = stylex.create({
  spinner: {
    display: "inline-block",
    width: "16px",
    height: "16px",
    borderRadius: radii.full,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: colors.border,
    borderTopColor: colors.accent,
    animationName: spin,
    animationDuration: "0.8s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  spinnerOnAccent: { borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" },
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    flexGrow: 1,
    minHeight: "40vh",
    color: colors.textMuted,
    fontSize: type.md,
  },
  code: {
    fontFamily: type.mono,
    fontSize: "0.92em",
    backgroundColor: colors.surfaceActive,
    color: colors.textMuted,
    borderRadius: radii.xs,
    paddingBlock: "1px",
    paddingInline: "5px",
  },
});

export const Spinner = ({ onAccent = false }: { onAccent?: boolean }) => (
  <span {...stylex.props(misc.spinner, onAccent && misc.spinnerOnAccent)} />
);

export const Loading = ({ text = "loading…" }: { text?: string }) => (
  <div {...stylex.props(misc.center)}>
    <Spinner /> {text}
  </div>
);

/** Inline code chip. */
export const Code = ({ children }: { children: ReactNode }) => (
  <code {...stylex.props(misc.code)}>{children}</code>
);

/** Small helper for keyboard-dismissable overlays. */
export const useEscape = (onEscape: () => void) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onEscape]);
};
