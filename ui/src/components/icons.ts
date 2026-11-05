import {
  Activity, Archive, BadgeCheck, Boxes, Camera, Check, ChevronDown, ChevronUp, ChevronsUpDown,
  CircleDashed, Cpu, Disc3, Fingerprint, Folder, FolderTree, Gauge, Globe, Group, HardDrive,
  KeyRound, KeySquare, Layers, LayoutDashboard, LockKeyhole, LogOut, MapPin, Menu, Monitor, Moon,
  Network, Package, Router, Search, Server, ServerCog, Shield, Split, Sun, Tags, Users, UsersRound,
  Waypoints, Terminal, Plug, Copy, Download, Plus, Trash2, Pencil, X, UserPlus, TriangleAlert,
  ArrowLeft, KeyRound as Key, CircleCheck, Info, Ellipsis, ShieldCheck, LockOpen, Lock, Upload, HardDriveUpload, RefreshCw, Columns3, FileDown, ChevronsLeft, ChevronsRight,
  ChevronLeft, ChevronRight, Ban, Power,
  EllipsisVertical, ExternalLink, Maximize2, ArrowUp, ArrowDown, Unlink, Link2, ScrollText, History,
  RotateCcw, LifeBuoy, MoveRight, Pause, Play, Cable, Image, Eye, EyeOff, ArrowRightLeft, Expand, Undo2,
  Scaling, Hammer, Unplug, ShieldPlus, Rocket, CopyPlus, SquarePen, Settings2,
  Database, DatabaseBackup, ArchiveRestore, Inbox, Send, ListPlus, ListMinus, Minus, Share2, ChartBar, Cloud, Minimize2,
  Radio, Container, SlidersHorizontal, RadioTower, EthernetPort, File, FolderPlus, FolderUp, FolderOpen, Wrench, Eraser, FileCode, PanelLeftClose, PanelLeftOpen, ListChecks,
  type LucideIcon,
} from "lucide-react";

/**
 * Icons addressable by kebab-case name (nav items from the server use these names).
 * Extensions add theirs with `registerIcons` from "@rassvet/sdk".
 */
const registry: Record<string, LucideIcon> = {
  activity: Activity, archive: Archive, "badge-check": BadgeCheck, boxes: Boxes, camera: Camera,
  check: Check, "chevron-down": ChevronDown, "chevron-up": ChevronUp,
  "chevrons-up-down": ChevronsUpDown, "circle-dashed": CircleDashed, cpu: Cpu, "disc-3": Disc3,
  fingerprint: Fingerprint, folder: Folder, "folder-tree": FolderTree, gauge: Gauge, globe: Globe,
  group: Group, "hard-drive": HardDrive, "key-round": KeyRound, "key-square": KeySquare,
  layers: Layers, "layout-dashboard": LayoutDashboard, "lock-keyhole": LockKeyhole,
  "log-out": LogOut, "map-pin": MapPin, menu: Menu, monitor: Monitor, moon: Moon,
  network: Network, package: Package, router: Router, search: Search, server: Server,
  "server-cog": ServerCog, shield: Shield, split: Split, sun: Sun, tags: Tags, users: Users,
  "users-round": UsersRound, waypoints: Waypoints, terminal: Terminal, plug: Plug, copy: Copy,
  download: Download, plus: Plus, trash: Trash2, pencil: Pencil, x: X, "user-plus": UserPlus,
  warning: TriangleAlert, "arrow-left": ArrowLeft, key: Key, "circle-check": CircleCheck,
  info: Info, ellipsis: Ellipsis, "shield-check": ShieldCheck, lock: Lock, "lock-open": LockOpen, upload: Upload, "hard-drive-upload": HardDriveUpload, refresh: RefreshCw, columns: Columns3,
  "file-down": FileDown, "chevrons-left": ChevronsLeft, "chevrons-right": ChevronsRight,
  "chevron-left": ChevronLeft, "chevron-right": ChevronRight, ban: Ban, power: Power,
  "more-vertical": EllipsisVertical, "external-link": ExternalLink, maximize: Maximize2,
  "arrow-up": ArrowUp, "arrow-down": ArrowDown, unlink: Unlink, link: Link2, "scroll-text": ScrollText,
  history: History, "rotate-ccw": RotateCcw, "life-buoy": LifeBuoy, "move-right": MoveRight,
  pause: Pause, play: Play, cable: Cable, image: Image, eye: Eye, "eye-off": EyeOff, "arrow-right-left": ArrowRightLeft,
  expand: Expand, undo: Undo2, scaling: Scaling, hammer: Hammer, unplug: Unplug,
  "shield-plus": ShieldPlus, rocket: Rocket, "copy-plus": CopyPlus, edit: SquarePen, settings: Settings2,
  database: Database, "database-backup": DatabaseBackup, "archive-restore": ArchiveRestore, inbox: Inbox, send: Send,
  "list-plus": ListPlus, "list-minus": ListMinus, minus: Minus, share: Share2, "chart-bar": ChartBar, cloud: Cloud, minimize: Minimize2,
  radio: Radio, container: Container, "sliders-horizontal": SlidersHorizontal, "radio-tower": RadioTower, "ethernet-port": EthernetPort, file: File, "folder-plus": FolderPlus, "folder-up": FolderUp, "folder-open": FolderOpen,
  wrench: Wrench, eraser: Eraser, "file-code": FileCode, "panel-left-close": PanelLeftClose, "panel-left-open": PanelLeftOpen, "list-checks": ListChecks,
};

export function registerIcons(icons: Record<string, LucideIcon>) {
  Object.assign(registry, icons);
}

export function lookupIcon(name: string): LucideIcon {
  return registry[name] ?? CircleDashed;
}
