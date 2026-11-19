import * as React from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme/theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** The web's press feedback: scale to 0.96 over 120 ms with the smooth-out curve. */
export function PressableScale({ style, onPressIn, onPressOut, disabled, scaleTo, ...props }: Omit<PressableProps, "style"> & { style?: StyleProp<ViewStyle>; scaleTo?: number }) {
  const { motion } = useTheme();
  const scale = useSharedValue(1);
  const [x1, y1, x2, y2] = motion.easings.smoothOut;
  const timing = { duration: motion.press.durationMs, easing: Easing.bezier(x1, y1, x2, y2), reduceMotion: ReduceMotion.System };
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      style={[style, animatedStyle]}
      onPressIn={(event) => {
        if (!disabled) scale.value = withTiming(scaleTo ?? motion.press.scale, timing);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        scale.value = withTiming(1, timing);
        onPressOut?.(event);
      }}
    />
  );
}
