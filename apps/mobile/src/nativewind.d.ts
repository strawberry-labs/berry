import "react-native";

declare module "react-native" {
  interface ViewProps {
    className?: string | undefined;
  }
  interface TextProps {
    className?: string | undefined;
  }
  interface TextInputProps {
    className?: string | undefined;
  }
  interface PressableProps {
    className?: string | undefined;
  }
  interface ScrollViewProps {
    className?: string | undefined;
  }
}
