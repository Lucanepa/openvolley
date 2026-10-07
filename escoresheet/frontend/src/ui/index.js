// volleyui kit barrel. `import { Button, Card, Row, toast } from './kit';`
// Every file also works on its own (`import { Button } from './kit/Button.jsx'`).
// Styles are NOT imported here: import tokens.css once from the app's entry.

// ── Foundations ──
export {
  cn,
} from './cn.js';
export {
  APP_TZ,
  zonedParts,
  localeOf,
  weekdayLabel,
  dayLabel,
  timeLabel,
  shortDayLabel,
  dayTimeLabel,
  dayKey,
  todayKey,
  shiftDayKey,
  fmtInt,
  fmtDec,
  chf,
  chfSigned,
} from './format.js';
export {
  NOTICE,
  BANNER_BASE,
  BANNER,
  CHIP_BASE,
  CHIP_WRAP,
  CHIP_TONE,
  MICRO_BADGE,
  MICRO_BADGE_TONE,
  TONE_TEXT,
  TONE_RAIL,
  TOAST_ACCENT,
  CONFIRM_ACCEPT,
  DOT,
  SERIES,
  SERIES_SOFT,
  CHART_INK,
  CHART_INK_SOFT,
  CHART_GRID,
} from './tones.js';

// ── Controls ──
export {
  FOCUS_RING,
  FOCUS_RING_INSET,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  renderIcon,
  Button,
  ButtonGroup,
} from './Button.jsx';
export {
  ICON_BUTTON_VARIANTS,
  IconButton,
} from './IconButton.jsx';
export {
  Field,
  FormError,
  FormNotice,
} from './Field.jsx';
export {
  INPUT_SIZES,
  INPUT_INVALID,
  INPUT_NUMERIC,
  Input,
  SearchInput,
} from './Input.jsx';
export {
  DateField,
  TimeField,
  DateTimeField,
} from './DateField.jsx';
export {
  PickerPopover,
} from './PickerPopover.jsx';
export {
  Calendar,
} from './Calendar.jsx';
export {
  TimePanel,
} from './TimePanel.jsx';
export {
  shapeDateText,
  isoToDateText,
  parseIsoDate,
  parseDateText,
  shapeTimeText,
  parseTimeText,
  normalizeTime,
  splitDateTime,
  joinDateTime,
} from './dateTime.js';
export {
  SELECT_SIZES,
  SELECT_PANEL,
  SELECT_OPTION_ROW,
  Select,
  SelectTrigger,
} from './Select.jsx';
export {
  TEXTAREA_SIZES,
  Textarea,
} from './Textarea.jsx';
export {
  SwitchTrack,
  Switch,
  SwitchCard,
} from './Switch.jsx';
export {
  Checkbox,
  Radio,
} from './Checkbox.jsx';
export {
  SegmentedControl,
  FilterPill,
  Segmented,
} from './SegmentedControl.jsx';

// ── Rows, lists, itemization ──
export {
  ROW_WASH,
  RowList,
  DateRail,
  RowRail,
  PairTitle,
  Row,
  RowTool,
  SimpleRow,
  RowExpansion,
  ListPager,
} from './Row.jsx';
export {
  SectionHeader,
  SectionNote,
  ListHeader,
  SortLabel,
  GroupBand,
  DayHeader,
  Eyebrow,
  ShowMoreToggle,
  SectionHead,
} from './SectionHeader.jsx';
export {
  Chip,
  MarkRow,
  ChipLine,
  Mark,
  AlertMark,
  CountBadge,
} from './Chip.jsx';
export {
  STATUS_TONE,
  StatusPill,
  StatusPills,
  OutlinePill,
  FlagPill,
  DOT_TONE,
  StatusDot,
  DeltaPill,
} from './StatusPill.jsx';
export {
  KeyValue,
  KvLink,
  LedgerLine,
} from './KeyValue.jsx';
export {
  Table,
} from './Table.jsx';
export {
  EmptyState,
  EmptyLine,
  EmptyInset,
  EmptyInCard,
} from './EmptyState.jsx';
export {
  ProgressBar,
  StackedBar,
  BarList,
  ShareBar,
} from './ProgressBar.jsx';
export {
  StatTile,
  StatGrid,
  SummaryStrip,
  VerdictTile,
  MetricCard,
} from './StatCard.jsx';

// ── Surfaces and feedback ──
export {
  Card,
  CardHeader,
  CardHeading,
  CardMeta,
  CardFooter,
  Section,
  Grid,
  Block,
  SplitCard,
  HeroCard,
} from './Card.jsx';
export {
  Modal,
  modalCancelClass,
  modalPrimaryClass,
  modalSaveClass,
  modalDangerClass,
  ModalRecord,
  ActionSheet,
  ActionSheetItem,
  OptionsSheet,
  OptionsRow,
} from './Modal.jsx';
export { backdropDismiss } from './backdropDismiss.js';
export {
  subscribeConfirm,
  getConfirmSnapshot,
  confirmDialog,
  settleConfirm,
  subscribeToasts,
  getToastsSnapshot,
  dismissToast,
  toast,
} from './uiStore.js';
export {
  ConfirmDialog,
} from './ConfirmDialog.jsx';
export {
  ToastStack,
} from './Toast.jsx';
export {
  UiHost,
} from './UiHost.jsx';
export {
  Banner,
  Notice,
  FieldNote,
  Callout,
  ModalStrip,
  ConnectionBanner,
} from './Banner.jsx';
export {
  InfoHint,
} from './InfoHint.jsx';
export {
  AppSpinner,
} from './AppSpinner.jsx';
export {
  Skeleton,
  SkeletonRows,
  SkeletonForm,
  ListLoading,
  RowListSkeleton,
} from './Skeleton.jsx';
export {
  ErrorScreen,
  ErrorBoundary,
  UpdateNotice,
  GateMessage,
} from './ErrorScreen.jsx';

// ── App shell and layout ──
export {
  useBottomNavScrollPadding,
  AppPage,
  AppFooter,
  ModeBanner,
  ModeBannerButton,
} from './AppShell.jsx';
export {
  BottomNav,
  BottomNavItem,
} from './BottomNav.jsx';
export {
  consoleHeaderBtn,
  consoleHeaderBtnPrimary,
  ConsoleShell,
  ConsoleBadge,
  ConsolePanel,
} from './ConsoleShell.jsx';
export {
  TitleCard,
  ReadingHeader,
  PageLead,
  CenteredBrand,
} from './PageHeader.jsx';
export {
  ReadingPage,
  FormPage,
  GateScreen,
} from './ReadingPage.jsx';
export {
  PageToolbar,
  toolbarBtn,
  BackButton,
  PaperSheet,
  SubmitBar,
  LockedNotice,
  StickyBottomBar,
} from './PageToolbar.jsx';
export {
  Fab,
} from './Fab.jsx';
