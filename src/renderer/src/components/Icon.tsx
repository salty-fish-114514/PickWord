/**
 * 极简 SVG 图标集合。
 * 为什么自己写：产品要求零第三方依赖，而我们只需要十几个线性图标，
 * 用一个 switch 返回不同的 <svg> 足够了。
 */

export type IconName =
  | "search"
  | "settings"
  | "close"
  | "undo"
  | "redo"
  | "sun"
  | "moon"
  | "save"
  | "sidebar"
  | "anchor"
  | "sparkle"
  | "chevron"
  | "export"
  | "locate"
  | "open"
  | "arrow-left"
  | "plus"
  | "more"
  | "trash"
  | "edit"
  | "folder"
  | "upload"
  | "warning"
  | "chapters"
  | "outline"
  | "person"
  | "lore"
  | "book"
  | "check"
  | "copy"
  | "clipboard"
  | "scissors"
  | "text"
  | "textSize";

interface IconProps {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18 }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (name) {
    case "search":
      return (
        <svg {...common}>
          <circle cx="10.8" cy="10.8" r="6.5" />
          <path d="m16 16 4.1 4.1" />
        </svg>
      );
    case "settings":
      // 齿轮：外圈 8 个齿 + 中心圆。之前的「圆 + 放射线」在小尺寸下看起来像太阳，已换掉。
      return (
        <svg {...common}>
          <path d="M10.3 3.6h3.4l.5 2.3 1.6.9 2.2-.8 1.7 2.9-1.7 1.6v1.8l1.7 1.6-1.7 2.9-2.2-.8-1.6.9-.5 2.3h-3.4l-.5-2.3-1.6-.9-2.2.8-1.7-2.9 1.7-1.6v-1.8L4.3 8.9 6 6l2.2.8 1.6-.9z" />
          <circle cx="12" cy="12" r="2.8" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      );
    case "undo":
      return (
        <svg {...common}>
          <path d="M9 14 4 9l5-5" />
          <path d="M5 9h8a6 6 0 0 1 6 6v1" />
        </svg>
      );
    case "redo":
      return (
        <svg {...common}>
          <path d="m15 14 5-5-5-5" />
          <path d="M19 9h-8a6 6 0 0 0-6 6v1" />
        </svg>
      );
    case "sun":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
        </svg>
      );
    case "moon":
      return (
        <svg {...common}>
          <path d="M20.2 15.4A8.3 8.3 0 0 1 8.6 3.8 8.3 8.3 0 1 0 20.2 15.4Z" />
        </svg>
      );
    case "save":
      return (
        <svg {...common}>
          <path d="M5 4h11l3 3v13H5z" />
          <path d="M8 4v5h7V4M8 20v-6h8v6" />
        </svg>
      );
    case "sidebar":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M14.5 4.5v15" />
        </svg>
      );
    case "anchor":
      return (
        <svg {...common}>
          <circle cx="12" cy="5.5" r="2.2" />
          <path d="M12 7.7V20M7 11H4.5a7.5 7.5 0 0 0 15 0H17" />
        </svg>
      );
    case "chapters":
      return (
        <svg {...common}>
          <path d="M5 5.5h14M5 10h9M5 14.5h14M5 19h9" />
        </svg>
      );
    case "outline":
      return (
        <svg {...common}>
          <path d="M8 6h11M8 12h11M8 18h11" />
          <circle cx="4.5" cy="6" r="1" />
          <circle cx="4.5" cy="12" r="1" />
          <circle cx="4.5" cy="18" r="1" />
        </svg>
      );
    case "person":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.6" />
          <path d="M4.8 20c.7-4 3.6-6.2 7.2-6.2s6.5 2.2 7.2 6.2" />
        </svg>
      );
    case "lore":
      return (
        <svg {...common}>
          <path d="M12 3.5 20 8v8l-8 4.5L4 16V8z" />
          <path d="M12 12.5 20 8M12 12.5 4 8M12 12.5v8" />
        </svg>
      );
    case "book":
      return (
        <svg {...common}>
          <path d="M4.5 5.5A2 2 0 0 1 6.5 3.5h13v15h-13a2 2 0 0 0-2 2z" />
          <path d="M4.5 18.5a2 2 0 0 1 2-2h13M8 7.5h7" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <rect x="8.5" y="8.5" width="11" height="11" rx="1.6" />
          <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...common}>
          <rect x="5.5" y="5" width="13" height="15.5" rx="1.8" />
          <path d="M9 5V3.5h6V5M9 11h6M9 15h4" />
        </svg>
      );
    case "scissors":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="2.5" />
          <circle cx="7" cy="17" r="2.5" />
          <path d="M9 8.5 19.5 19M9 15.5 19.5 5" />
        </svg>
      );
    case "text":
      // 字体：衬线大写字干（上横 + 竖 + 下横），一眼能认出是「字型」而不是铅笔。
      return (
        <svg {...common}>
          <path d="M5.5 7.5V5.5h13v2" />
          <path d="M12 5.5v13" />
          <path d="M8.8 18.5h6.4" />
        </svg>
      );
    case "textSize":
      // 字号：一个大 T 加一个小 t。
      return (
        <svg {...common}>
          <path d="M4 7.5V6h8v1.5" />
          <path d="M8 6v11.5" />
          <path d="M13.5 15v-1.2h6V15" />
          <path d="M16.5 13.8v3.7" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "export":
      return (
        <svg {...common}>
          <path d="M12 15V4m0 0L8.5 7.5M12 4l3.5 3.5" />
          <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
        </svg>
      );
    case "locate":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v3m0 12v3M3 12h3m12 0h3" />
        </svg>
      );
    case "open":
      return (
        <svg {...common}>
          <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
          <path d="M3.5 11h17" />
        </svg>
      );
    case "arrow-left":
      return <svg {...common}><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg>;
    case "plus":
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case "more":
      return <svg {...common}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>;
    case "trash":
      return <svg {...common}><path d="M4 7h16M10 7V4h4v3m-8 0 1 13h10l1-13M10 11v5m4-5v5" /></svg>;
    case "edit":
      return <svg {...common}><path d="m15 5 4 4M4 20l4.5-1 10-10a2 2 0 0 0-4-4l-10 10z" /></svg>;
    case "folder":
      return <svg {...common}><path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></svg>;
    case "upload":
      return <svg {...common}><path d="M12 16V4m0 0L8 8m4-4 4 4M4 16v3h16v-3" /></svg>;
    case "warning":
      // 三角感叹号：用于警告和提示
      return (
        <svg {...common}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
  }
}
