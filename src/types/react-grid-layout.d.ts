// Shim de tipos pro react-grid-layout v1.5.x.
// O pacote @types/react-grid-layout é uma stub deprecated (e a lib v1 não
// exporta types próprios). Declaramos só o subset usado pelo modo análise.

declare module "react-grid-layout" {
  import type { ComponentType, CSSProperties, ReactNode } from "react";

  export interface Layout {
    i: string;
    x: number;
    y: number;
    w: number;
    h: number;
    minW?: number;
    minH?: number;
    maxW?: number;
    maxH?: number;
    static?: boolean;
  }

  export type Layouts = { [breakpoint: string]: Layout[] };

  export interface ResponsiveProps {
    className?: string;
    layouts: Layouts;
    cols: Record<string, number>;
    breakpoints: Record<string, number>;
    rowHeight?: number;
    margin?: [number, number];
    containerPadding?: [number, number];
    onLayoutChange?: (current: Layout[], all: Layouts) => void;
    draggableHandle?: string;
    /** Selector CSS pra elementos que NÃO devem disparar drag dentro do handle.
     *  Ex: ".analysis-no-drag" pra select/button interativos. */
    draggableCancel?: string;
    compactType?: "vertical" | "horizontal" | null;
    preventCollision?: boolean;
    children: ReactNode;
    width?: number;
    style?: CSSProperties;
  }

  export const Responsive: ComponentType<ResponsiveProps>;

  /**
   * HOC que injeta `width` no componente Responsive medindo o container DOM.
   */
  export function WidthProvider<P extends object>(
    Component: ComponentType<P>,
  ): ComponentType<Omit<P, "width">>;
}
