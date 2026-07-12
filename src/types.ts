import type { ViewProps } from 'react-native';

export type SignatureChangeEvent = {
  nativeEvent: {
    isEmpty: boolean;
  };
};

export type SignatureViewProps = {
  /** Ink color. Any CSS color string. Default `"black"`. */
  penColor?: string;
  /** Minimum stroke half-width, reached at high velocity. Default `0.5`. */
  minWidth?: number;
  /** Maximum stroke half-width, reached at zero velocity. Default `2.5`. */
  maxWidth?: number;
  /**
   * Low-pass filter weight applied to the velocity, `0..1`.
   * Higher values react faster to speed changes. Default `0.7`.
   */
  velocityFilterWeight?: number;
  /** Touch samples closer than this (in dp/points/CSS px) are dropped. Default `5`. */
  minDistance?: number;
  /** Radius of the dot drawn for a single tap. `0` means `(minWidth + maxWidth) / 2`. Default `0`. */
  dotSize?: number;
  /** Background of the drawing surface. Not baked into exports — see `SaveOptions.backgroundColor`. */
  backgroundColor?: string;
  /** First touch of a stroke. */
  onBegin?: () => void;
  /** Stroke ended (touch up / cancel). */
  onEnd?: () => void;
  /** Fired when emptiness changes (first ink, clear) and after each completed stroke. */
  onChange?: (event: SignatureChangeEvent) => void;
} & ViewProps;

export type SaveFormat = 'png' | 'jpeg';

export type SaveOptions = {
  /** Export format. Default `"png"`. */
  format?: SaveFormat;
  /** JPEG quality, `0..1`. Ignored for PNG. Default `0.92`. */
  quality?: number;
  /**
   * Background color baked into the exported image. PNG defaults to transparent;
   * JPEG (no alpha channel) defaults to white when not provided.
   */
  backgroundColor?: string;
  /** Crop the export to the ink bounding box. Default `false`. */
  trim?: boolean;
};

export interface SignatureViewRef {
  /** Erase all ink and reset the stroke state. */
  clear(): Promise<void>;
  /** `true` while nothing has been drawn since mount/clear. */
  isEmpty(): Promise<boolean>;
  /** Rasterize the signature and return it as bare base64 (no `data:` prefix). */
  save(options?: SaveOptions): Promise<string>;
}
