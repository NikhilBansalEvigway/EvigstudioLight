import React from 'react';

interface LogoProps {
    className?: string;
}

export function Logo({ className = "w-6 h-6" }: LogoProps) {
    return (
        <div className={`flex items-center gap-2 ${className}`}>
            <svg
                viewBox="0 0 100 60"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="w-full h-full"
            >
                <defs>
                    <linearGradient id="gearGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#FB923C" />
                        <stop offset="100%" stopColor="#EF4444" />
                    </linearGradient>
                </defs>
                {/* Left Gear */}
                <path
                    d="M35 30c0-8.284-6.716-15-15-15S5 21.716 5 30s6.716 15 15 15 15-6.716 15-15Z"
                    stroke="url(#gearGradient)"
                    strokeWidth="6"
                    strokeDasharray="4 2"
                />
                {/* Right Gear */}
                <path
                    d="M65 30c0-8.284 6.716-15 15-15s15 6.716 15 15-6.716 15-15 15-15-6.716-15-15Z"
                    stroke="url(#gearGradient)"
                    strokeWidth="6"
                    strokeDasharray="4 2"
                />
                {/* Connector to form Infinity */}
                <path
                    d="M35 30c5 0 10 0 15 0s10 0 15 0"
                    stroke="url(#gearGradient)"
                    strokeWidth="4"
                    strokeLinecap="round"
                />
            </svg>
        </div>
    );
}
