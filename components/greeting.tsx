import { motion } from 'framer-motion';
import Image from 'next/image';

export const Greeting = () => {
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
          className="flex items-center gap-3"
        >
          <Image
            src="/images/berry-logo.png"
            alt="Berry Logo"
            width={72}
            height={72}
            className="rounded-lg"
          />
          <span className="text-5xl font-bold text-foreground">Berry</span>
        </motion.div>
    </div>
  );
};
