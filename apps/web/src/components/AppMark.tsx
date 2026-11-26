import type { SVGProps } from "react";

export function AppMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <text
        x="12"
        y="12"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize="15"
        fontWeight="700"
        fill="currentColor"
      >
        {"yl"}
      </text>
    </svg>
  );
}
