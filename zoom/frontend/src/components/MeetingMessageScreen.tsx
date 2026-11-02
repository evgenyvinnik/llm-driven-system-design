interface MeetingMessageScreenProps {
  title?: string;
  message: string;
  detail?: string;
  backLabel?: string;
  onBack: () => void;
  /** Waiting-room variant: shows a pulsing indicator. */
  waiting?: boolean;
}

/** Full-page message for meeting states with no meeting UI: waiting room, ended, removed, refused. */
export function MeetingMessageScreen({ title, message, detail, backLabel = 'Back to Dashboard', onBack, waiting }: MeetingMessageScreenProps) {
  return (
    <div className="h-full flex items-center justify-center flex-col gap-4 p-6 text-center">
      {title && <h1 className="text-2xl font-bold text-zoom-text">{title}</h1>}
      {waiting && <div className="w-12 h-12 rounded-full bg-zoom-primary/30 animate-pulse" aria-hidden />}
      <div className={`text-lg ${waiting ? 'text-zoom-text' : 'text-zoom-red'}`}>{message}</div>
      {detail && <div className="text-zoom-secondary text-sm">{detail}</div>}
      <button
        onClick={onBack}
        className="bg-zoom-primary hover:bg-zoom-hover text-white px-6 py-2 rounded-lg"
      >
        {backLabel}
      </button>
    </div>
  );
}
