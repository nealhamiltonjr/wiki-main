import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/features/theme/ThemeContext";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-surface-elevated group-[.toaster]:text-text group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-text-muted",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-text",
          cancelButton: "group-[.toast]:bg-bg-tertiary group-[.toast]:text-text",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
