export function RovoLogo({
  className,
  width,
  height,
  color = 'currentColor',
}: {
  className?: string;
  width?: number;
  height?: number;
  color?: string;
}) {
  return (
    <svg
      version="1.1"
      id="Layer_1"
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      x="0px"
      y="0px"
      className={className}
      fill="#282828"
      width={width}
      height={height}
      color={color}
      viewBox="0 0 1280 800"
      style={{ display: 'block', overflow: 'visible' }}
      xmlSpace="preserve"
    >
      <path
        id="XMLID_32_"
        className="st0"
        d="M322.6,383.8c0,75.9,0.6,151.7-0.1,227.6c-1,106.6,114.2,179.8,214,136.2
	c31.8-13.9,52.4-40,74.9-64.4C704.5,581.8,797.9,480.8,891,379.3c45.8-50,60.4-109.2,47.4-175c-16.9-85.3-87.8-159.1-181.5-162
	C649,38.9,541,39.3,433.1,40.5c-70,0.8-113.5,63.5-111.2,119.2C324.9,234.3,322.7,309.1,322.6,383.8z M942.3,666.8
	c4.4-41.3-35-93.7-92.6-92.6c-53.6,1-92.5,40.1-92.5,94.9c0,50.7,41.1,90.9,92.9,90.9C902.5,760,942.3,719.7,942.3,666.8z"
      />
    </svg>
  );
}
