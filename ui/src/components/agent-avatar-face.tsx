import { createMemo } from "solid-js";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";

const hues = [8, 32, 48, 82, 142, 174, 202, 232, 272, 322] as const;

/** The agent ID keeps every feature stable across clients and render order. */
export function AgentAvatarFace(props: { agentId: string }) {
  const features = createMemo(() => {
    const seed = fnv1aUtf16(props.agentId);
    const hue = hues[seed % hues.length];
    const eyeSeed = Math.floor(seed / hues.length);
    const mouthSeed = Math.floor(eyeSeed / 4);
    return {
      color: `hsl(${hue} 58% 62%)`,
      pale: `hsl(${hue} 65% 90%)`,
      ink: `hsl(${hue} 55% 18%)`,
      eyes: eyeSeed % 4,
      mouth: mouthSeed % 4,
      pastel: Math.floor(mouthSeed / 4) % 2 === 1,
    };
  });
  return (
    <svg
      class="identity-avatar__agent-face"
      viewBox="0 0 32 32"
      width="100%"
      height="100%"
      aria-hidden="true"
    >
      <circle
        cx="16"
        cy="16"
        r="16"
        fill={features().pastel ? features().pale : features().color}
      />
      <g fill={features().ink}>
        {features().eyes === 0 ? (
          <>
            <circle cx="11" cy="13.5" r="1.6" />
            <circle cx="21" cy="13.5" r="1.6" />
          </>
        ) : features().eyes === 1 ? (
          <>
            <ellipse cx="11" cy="13" rx="1.5" ry="2" />
            <ellipse cx="21" cy="13" rx="1.5" ry="2" />
          </>
        ) : features().eyes === 2 ? (
          <path
            d="M9 14q2-3 4 0m6 0q2-3 4 0"
            fill="none"
            stroke={features().ink}
            stroke-width="1.6"
            stroke-linecap="round"
          />
        ) : (
          <>
            <rect x="6.5" y="9" width="19" height="9.5" rx="4.75" />
            <g fill={features().pale}>
              <rect x="10.5" y="12" width="2.5" height="3.5" rx="1.25" />
              <rect x="19" y="12" width="2.5" height="3.5" rx="1.25" />
            </g>
          </>
        )}
        {features().mouth === 0 ? (
          <path
            d="M11.5 20q4.5 4.5 9 0"
            fill="none"
            stroke={features().ink}
            stroke-width="1.6"
            stroke-linecap="round"
          />
        ) : features().mouth === 1 ? (
          <>
            <path d="M11 19q5 1.5 10 0c-.5 4.5-3 6-5 6s-4.5-1.5-5-6Z" />
            <path d="M13.5 23q2.5-2 5 0-2.5 2-5 0Z" fill={features().pale} />
          </>
        ) : features().mouth === 2 ? (
          <path
            d="M12 22q5 2 8-1"
            fill="none"
            stroke={features().ink}
            stroke-width="1.6"
            stroke-linecap="round"
          />
        ) : (
          <path
            d="M13.5 22.5h5"
            fill="none"
            stroke={features().ink}
            stroke-width="1.6"
            stroke-linecap="round"
          />
        )}
      </g>
    </svg>
  );
}
