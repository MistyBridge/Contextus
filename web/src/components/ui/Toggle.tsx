// 开关：同步最新代码（T8 syncMode）等布尔选项；只动 transform/opacity
interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}

export default function Toggle({ checked, onChange, label }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-[13px] text-text-2 hover:text-text select-none"
    >
      <span
        className={`relative h-4 w-7 rounded-full transition-colors ${checked ? "bg-accent" : "bg-border"}`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-1 transition-transform ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
      {label}
    </button>
  );
}
