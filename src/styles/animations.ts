import type { Variants } from "framer-motion";

export const containerVariants: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.05 } },
};

export const cardVariants: Variants = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.32, ease: "easeOut" } },
};

export const cardHover = {
  whileHover: { scale: 1.005, y: -2 },
  transition: { type: "spring", stiffness: 380, damping: 24 },
} as const;

export const buttonHover = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.98 },
} as const;

export const modalVariants: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.18, ease: "easeOut" } },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.14 } },
};

export const overlayVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.18 } },
  exit: { opacity: 0, transition: { duration: 0.14 } },
};

export const slideInRight: Variants = {
  initial: { x: 480, opacity: 0 },
  animate: {
    x: 0,
    opacity: 1,
    transition: { type: "spring", stiffness: 320, damping: 32 },
  },
  exit: { x: 480, opacity: 0, transition: { duration: 0.18 } },
};
