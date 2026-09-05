import React from 'react';
import { motion } from 'framer-motion';

type ChartStyle = React.CSSProperties & { '--chart-color': string };

interface StatCardProps {
    title: string;
    value: string | number;
    sub?: React.ReactNode;
    icon: string;
    trend?: number[];
    distribution?: { label: string; value: number; color: string }[];
    progress?: {
        value: number; // 0-100
        label?: string;
        color?: string;
    } | {
        segments: { value: number; color: string; label?: string }[];
    };
    color: 'indigo' | 'green' | 'blue' | 'teal' | 'purple' | 'sky' | 'amber' | 'rose';
    chartType?: 'line' | 'bar' | 'area' | 'radial' | 'donut' | 'dots' | 'split';
    isLoading?: boolean;
    fixedMax?: number;
    className?: string;
}

const AreaSparkline: React.FC<{ data: number[]; color: string; id: string; fixedMax?: number }> = ({ data, color, id, fixedMax }) => {
    const cleanData = (data || []).map(d => (typeof d === 'number' && !isNaN(d)) ? d : 0);
    if (cleanData.length < 2) return null;

    const min = Math.min(...cleanData);
    const max = fixedMax !== undefined ? fixedMax : Math.max(...cleanData);
    const range = (max - min) || 1;
    const width = 100;
    const height = 40;

    const points = cleanData.map((d, i) => ({
        x: (i / (cleanData.length - 1)) * width,
        y: height - ((d - min) / range) * height
    }));

    const curvePath = points.reduce((acc, point, i, a) => {
        if (i === 0) return `M ${point.x},${point.y}`;
        const prev = a[i - 1];
        if (!prev) return acc;
        const cp1x = prev.x + (point.x - prev.x) / 3;
        const cp2x = point.x - (point.x - prev.x) / 3;
        return `${acc} C ${cp1x},${prev.y} ${cp2x},${point.y} ${point.x},${point.y}`;
    }, "");

    const areaPath = `${curvePath} L ${width},${height} L 0,${height} Z`;

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-10 overflow-visible" preserveAspectRatio="none">
            <defs>
                <linearGradient id={`grad-${id.replace(/\s+/g, '-')}`} x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor={color} stopOpacity="0.4" />
                    <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
            </defs>
            <motion.path
                initial={{ d: `M 0,${height} L 100,${height} L 100,${height} L 0,${height} Z` }}
                animate={{ d: areaPath }}
                transition={{ duration: 1, ease: "easeOut" }}
                fill={`url(#grad-${id.replace(/\s+/g, '-')})`}
            />
            <motion.path
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.2, ease: "easeInOut" }}
                fill="none"
                stroke={color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                d={curvePath}
            />
        </svg>
    );
};

const RadialProgress: React.FC<{ value: number; color: string }> = ({ value, color }) => {
    const safeValue = Math.min(100, Math.max(0, (typeof value === 'number' && !isNaN(value)) ? value : 0));
    const radius = 18;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (safeValue / 100) * circumference;

    return (
        <div className="flex items-center justify-center h-10 w-full">
            <svg className="h-10 w-10 transform -rotate-90 overflow-visible">
                <circle
                    className="text-slate-200/50 dark:text-dark-border/20"
                    strokeWidth="4"
                    stroke="currentColor"
                    fill="transparent"
                    r={radius}
                    cx="20"
                    cy="20"
                />
                <motion.circle
                    className="transition-all duration-1000"
                    strokeWidth="4"
                    strokeDasharray={circumference}
                    initial={{ strokeDashoffset: circumference }}
                    animate={{ strokeDashoffset: offset }}
                    strokeLinecap="round"
                    stroke={color}
                    fill="transparent"
                    r={radius}
                    cx="20"
                    cy="20"
                />
            </svg>
            <div className="chart-current-color ml-3 text-sm font-bold" style={{ '--chart-color': color } as ChartStyle}>
                {value.toFixed(1)}%
            </div>
        </div>
    );
};

const MiniDonutChart: React.FC<{ segments: { value: number; color: string }[] }> = ({ segments }) => {
    if (!segments || segments.length === 0) return null;
    const cleanSegments = segments.map(s => ({ ...s, value: (typeof s.value === 'number' && !isNaN(s.value)) ? s.value : 0 }));
    const total = cleanSegments.reduce((acc, s) => acc + s.value, 0) || 1;
    const radius = 18;
    const circumference = 2 * Math.PI * radius;

    let currentRotation = 0;

    return (
        <div className="flex items-center justify-center h-10 w-full overflow-visible">
            <svg className="h-10 w-10 transform -rotate-90 overflow-visible">
                {cleanSegments.map((seg, i) => {
                    const segmentCircum = (seg.value / total) * circumference;
                    const dashOffset = circumference - segmentCircum;
                    const rotate = (currentRotation / total) * 360;
                    currentRotation += seg.value;

                    return (
                        <motion.circle
                            key={i}
                            strokeWidth="4"
                            strokeDasharray={circumference}
                            initial={{ strokeDashoffset: circumference }}
                            animate={{ strokeDashoffset: dashOffset, rotate }}
                            transition={{ duration: 1, delay: i * 0.1 }}
                            stroke={seg.color}
                            fill="transparent"
                            r={radius}
                            cx="20"
                            cy="20"
                            className="chart-donut-segment"
                        />
                    );
                })}
            </svg>
            <div className="ml-2 flex flex-row gap-2">
                {segments.slice(0, 3).map((seg, i) => (
                    <div key={i} className="chart-color-fill w-1.5 h-1.5 rounded-full" style={{ '--chart-color': seg.color } as ChartStyle} />
                ))}
            </div>
        </div>
    );
};

const MiniBarChart: React.FC<{ data: number[] }> = ({ data }) => {
    const cleanData = (data || []).map(d => (typeof d === 'number' && !isNaN(d)) ? d : 0);
    if (cleanData.length < 1) return null;

    const max = Math.max(...cleanData) || 1;
    const width = 100;
    const height = 30;
    const barWidth = (width / cleanData.length) * 0.7;
    const gap = (width / cleanData.length) * 0.3;

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-8 opacity-70" preserveAspectRatio="none">
            {cleanData.map((d, i) => {
                const barHeight = (d / max) * height;
                const x = i * (width / cleanData.length) + gap / 2;
                const y = height - barHeight;
                return (
                    <motion.rect
                        key={i}
                        x={x}
                        y={height}
                        width={barWidth}
                        height={0}
                        animate={{ height: barHeight, y }}
                        transition={{ duration: 0.5, delay: i * 0.05 }}
                        fill="currentColor"
                        className="chart-current-color"
                        rx={1}
                    />
                );
            })}
        </svg>
    );
};

const SegmentedProgressBar: React.FC<{ progress: StatCardProps['progress'] }> = ({ progress }) => {
    if (!progress) return null;

    let segments: { value: number; color: string }[] = [];
    if ('segments' in progress) {
        segments = progress.segments;
    } else {
        segments = [{ value: progress.value, color: progress.color || 'var(--stat-color)' }];
    }

    return (
        <div className="w-full h-1.5 bg-subtle rounded-full overflow-hidden flex flex-row">
            {segments.map((seg, i) => (
                <motion.div
                    key={i}
                    initial={{ width: 0 }}
                    animate={{ width: `${seg.value}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="chart-color-fill h-full"
                    style={{ '--chart-color': seg.color } as ChartStyle}
                />
            ))}
        </div>
    );
};

const DotProgress: React.FC<{ value: number; color: string }> = ({ value, color }) => {
    const dots = Array.from({ length: 20 });
    const activeDots = Math.round((value / 100) * 20);

    return (
        <div className="flex items-center justify-between w-full h-6 px-1">
            {dots.map((_, i) => (
                <motion.div
                    key={i}
                    initial={{ opacity: 0.1, scale: 0.8 }}
                    animate={{
                        opacity: i < activeDots ? 1 : 0.2,
                        scale: i < activeDots ? 1.1 : 0.8,
                    }}
                    transition={{ duration: 0.4, delay: i * 0.02 }}
                    className="chart-color-fill w-2 h-2 rounded-full shadow-sm"
                    style={{ '--chart-color': color } as ChartStyle}
                />
            ))}
        </div>
    );
};

const SplitProgressBar: React.FC<{ value: number; color: string }> = ({ value, color }) => {
    const segments = 20;
    const activeSegments = Math.round((value / 100) * segments);

    return (
        <div className="flex items-center gap-0.5 h-1.5 w-full">
            {Array.from({ length: segments }).map((_, i) => (
                <motion.div
                    key={i}
                    initial={{ opacity: 0.1, scaleX: 0.8 }}
                    animate={{
                        opacity: i < activeSegments ? 1 : 0.1,
                        scaleX: 1,
                    }}
                    transition={{ duration: 0.4, delay: i * 0.02 }}
                    className={`flex-1 h-full rounded-full ${i < activeSegments ? 'chart-color-fill' : 'chart-muted-fill'}`}
                    style={{ '--chart-color': color } as ChartStyle}
                />
            ))}
        </div>
    );
};

const StatCard: React.FC<StatCardProps> = ({
    title,
    value,
    sub,
    icon,
    trend,
    progress,
    distribution,
    color,
    chartType = 'line',
    isLoading,
    fixedMax,
    className = ""
}) => {
    const colorMap = {
        indigo: 'var(--color-primary)',
        green: 'var(--color-success)',
        blue: 'var(--color-info)',
        teal: 'var(--color-success)',
        purple: 'var(--color-purple)',
        sky: 'var(--color-info)',
        amber: 'var(--color-warning)',
        rose: 'var(--color-error)',
    };

    if (isLoading) {
        return (
            <div className={`stat-card-base animate-pulse ${className}`}>
                <div className="stat-card-header">
                    <div className="stat-card-icon-wrapper skeleton rounded-2xl" />
                    <div className="stat-card-info">
                        <div className="h-2 w-16 skeleton rounded-full mb-2" />
                        <div className="h-6 w-24 skeleton rounded-full" />
                    </div>
                </div>
                <div className="stat-card-chart-container">
                    <div className="h-8 w-full skeleton rounded-xl" />
                </div>
                {sub && (
                    <div className="stat-card-footer mt-auto pt-3 border-t border-light">
                        <div className="h-2 w-20 skeleton rounded-full" />
                    </div>
                )}
            </div>
        );
    }

    return (
        <motion.div
            whileHover={{ y: -5, scale: 1.01 }}
            className={`stat-card-base ${className}`}
            style={{ '--stat-color': colorMap[color] } as React.CSSProperties}
        >
            <div className="stat-card-header">
                <div className={`stat-card-icon-wrapper stat-icon-${color}`}>
                    <span className="material-symbols-rounded text-xl">{icon}</span>
                </div>

                <div className="stat-card-info">
                    <p className="stat-label-top">
                        {title}
                    </p>
                    <h3 className="stat-number-main">
                        {value}
                    </h3>
                </div>
            </div>

            <div className="stat-card-chart-container">
                {progress ? (
                    chartType === 'radial' ? (
                        <RadialProgress
                            value={'value' in progress ? progress.value : 0}
                            color="var(--stat-color)"
                        />
                    ) : chartType === 'dots' ? (
                        <DotProgress value={'value' in progress ? progress.value : 0} color="var(--stat-color)" />
                    ) : chartType === 'split' ? (
                        <SplitProgressBar value={'value' in progress ? progress.value : 0} color="var(--stat-color)" />
                    ) : (
                        <SegmentedProgressBar progress={progress} />
                    )
                ) : chartType === 'area' && trend ? (
                    <AreaSparkline data={trend} color="var(--stat-color)" id={title} fixedMax={fixedMax} />
                ) : chartType === 'radial' && typeof value === 'string' && value.includes('%') ? (
                    <RadialProgress value={parseFloat(value)} color="var(--stat-color)" />
                ) : chartType === 'bar' && trend ? (
                    <MiniBarChart data={trend} />
                ) : chartType === 'donut' && distribution ? (
                    <MiniDonutChart segments={distribution} />
                ) : (
                    trend && trend.length > 0 && (
                        <div className="w-full h-full flex items-center justify-center">
                            <AreaSparkline data={trend} color="var(--stat-color)" id={title} fixedMax={fixedMax} />
                        </div>
                    )
                )}
            </div>

            {sub && (
                <div className="stat-card-footer">
                    {sub}
                </div>
            )}
        </motion.div>
    );
};

export default StatCard;
