import { motion } from 'framer-motion';
import { memo } from 'react';
import { BerryIcon } from './icons';

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
          {/* Mobile: size 60, SM: size 80, MD+: size 100 */}
          <div className="sm:hidden">
            <BerryIcon size={60} className="-translate-y-2" />
          </div>
          <div className="hidden sm:block md:hidden">
            <BerryIcon size={80} className="-translate-y-2" />
          </div>
          <div className="hidden md:block">
            <BerryIcon size={100} className="-translate-y-2" />
          </div>
          <span className="text-4xl sm:text-5xl md:text-6xl font-bold text-foreground">Berry</span>
        </motion.div>
    </div>
  );
};

export const Greeting = memo(PureGreeting);
