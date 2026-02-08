import { useState, useCallback, useEffect, useRef } from "react";

interface UseSlideshowOptions {
  totalImages: number;
  interval: number; // seconds, 0 = manual
  autoPlay?: boolean;
}

export function useSlideshow({ totalImages, interval, autoPlay = true }: UseSlideshowOptions) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay && interval > 0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    if (interval > 0) {
      timerRef.current = setInterval(() => {
        setCurrentIndex((prev) => (prev + 1) % totalImages);
      }, interval * 1000);
    }
  }, [interval, totalImages, clearTimer]);

  // Auto-advance
  useEffect(() => {
    if (isPlaying && interval > 0 && totalImages > 1) {
      startTimer();
    } else {
      clearTimer();
    }
    return clearTimer;
  }, [isPlaying, interval, totalImages, startTimer, clearTimer]);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % totalImages);
    // Reset timer on manual navigation
    if (isPlaying && interval > 0) {
      startTimer();
    }
  }, [totalImages, isPlaying, interval, startTimer]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => (prev - 1 + totalImages) % totalImages);
    if (isPlaying && interval > 0) {
      startTimer();
    }
  }, [totalImages, isPlaying, interval, startTimer]);

  const togglePlay = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  const goTo = useCallback((index: number) => {
    setCurrentIndex(index % totalImages);
    if (isPlaying && interval > 0) {
      startTimer();
    }
  }, [totalImages, isPlaying, interval, startTimer]);

  return {
    currentIndex,
    isPlaying,
    goNext,
    goPrev,
    togglePlay,
    goTo,
    totalImages,
  };
}
