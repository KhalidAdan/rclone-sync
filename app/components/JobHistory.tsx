import {
  ArrowPathIcon,
  ArrowRightOnRectangleIcon,
  CheckCircleIcon,
  ClipboardDocumentCheckIcon,
  ClockIcon,
  CloudArrowUpIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";

type Event = {
  id: number;
  eventType: string;
  message: string;
  timestamp: string;
};

type EventConfig = {
  icon: React.ElementType;
  iconClass: string;
  ringClass: string;
};

const eventConfig: Record<string, EventConfig> = {
  created:   { icon: CloudArrowUpIcon,          iconClass: "text-blue-600",   ringClass: "bg-blue-50 ring-blue-200" },
  queued:    { icon: ClockIcon,                 iconClass: "text-orange-500", ringClass: "bg-orange-50 ring-orange-200" },
  archiving: { icon: ArrowRightOnRectangleIcon, iconClass: "text-purple-600", ringClass: "bg-purple-50 ring-purple-200" },
  verifying: { icon: ClipboardDocumentCheckIcon,iconClass: "text-indigo-600", ringClass: "bg-indigo-50 ring-indigo-200" },
  completed: { icon: CheckCircleIcon,           iconClass: "text-green-600",  ringClass: "bg-green-50 ring-green-200" },
  failed:    { icon: XCircleIcon,               iconClass: "text-red-500",    ringClass: "bg-red-50 ring-red-200" },
  retried:   { icon: ArrowPathIcon,             iconClass: "text-blue-500",   ringClass: "bg-blue-50 ring-blue-200" },
};

const fallbackConfig: EventConfig = {
  icon: ClockIcon,
  iconClass: "text-gray-400",
  ringClass: "bg-gray-50 ring-gray-200",
};

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function JobHistory({ events }: { events: Event[] }) {
  if (!events || events.length === 0) return null;

  return (
    <div className="flow-root px-4 pt-2 pb-4">
      <ul role="list" className="-mb-6">
        {events.map((event, idx) => {
          const cfg = eventConfig[event.eventType] ?? fallbackConfig;
          const Icon = cfg.icon;
          const isLast = idx === events.length - 1;

          return (
            <li key={event.id}>
              <div className="relative pb-6">
                {!isLast && (
                  <span
                    aria-hidden="true"
                    className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-gray-200"
                  />
                )}
                <div className="relative flex gap-3">
                  <div className={`flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ${cfg.ringClass}`}>
                    <Icon aria-hidden="true" className={`size-4 ${cfg.iconClass}`} />
                  </div>
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-4 py-1">
                    <p className="text-sm text-gray-600">{event.message}</p>
                    <time
                      dateTime={event.timestamp}
                      title={new Date(event.timestamp).toLocaleString()}
                      className="shrink-0 text-xs text-gray-400"
                    >
                      {timeAgo(event.timestamp)}
                    </time>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
