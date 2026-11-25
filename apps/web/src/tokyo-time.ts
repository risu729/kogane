// The one formatter that shows an instant in Japan time. <Time> in
// changes-since.tsx and the schedule settings page both print through it.

const TOKYO_TIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  dateStyle: "medium",
  timeStyle: "short",
});

/** An ISO instant as a Japan-time date and minute, e.g. `2026/10/06 0:30`. */
export const tokyoTime = (value: string): string => TOKYO_TIME.format(new Date(value));
