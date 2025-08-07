import { motion } from 'framer-motion';
import Image from 'next/image';
import { memo } from 'react';

const PureGreeting = () => {
  return (
    <div
      key="overview"
      className="flex flex-col items-center"
    >
              <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ delay: 0.5 }}
          className="flex items-center gap-0"
        >
          <Image
            src="/images/berry-logo.png"
            alt="Berry Logo"
            width={100}
            height={100}
            className="rounded-lg -translate-y-2"
          />
          <span className="text-6xl font-bold text-foreground">Berry</span>
        </motion.div>
    </div>
  );
};

export const Greeting = memo(PureGreeting);
