// The package only ships types for its index; each icon module default-exports the same shape.
declare module "@hugeicons/core-free-icons/*" {
  const icon: import("@hugeicons/react-native").IconSvgElement;
  export default icon;
}
