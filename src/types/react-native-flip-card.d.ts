declare module 'react-native-flip-card' {
  import type { ComponentType, ReactNode } from 'react';
  import type { StyleProp, ViewStyle } from 'react-native';

  export type FlipCardProps = {
    alignHeight?: boolean;
    alignWidth?: boolean;
    children?: ReactNode;
    clickable?: boolean;
    flip?: boolean;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
    friction?: number;
    onFlipEnd?: (isFlipEnd: boolean) => void;
    onFlipStart?: (isFlipStart: boolean) => void;
    perspective?: number;
    style?: StyleProp<ViewStyle>;
    useNativeDriver?: boolean;
  };

  const FlipCard: ComponentType<FlipCardProps>;

  export const Face: ComponentType<{ children?: ReactNode; style?: StyleProp<ViewStyle> }>;
  export const Back: ComponentType<{ children?: ReactNode; style?: StyleProp<ViewStyle> }>;

  export default FlipCard;
}
