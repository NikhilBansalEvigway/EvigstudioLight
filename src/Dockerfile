FROM nginx:alpine

RUN apk add --no-cache openssl

RUN mkdir -p /etc/nginx/certs && openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout /etc/nginx/certs/server.key -out /etc/nginx/certs/server.crt -subj "/C=US/ST=Local/L=Local/O=EvigStudio/CN=localhost"

COPY dist/ /usr/share/nginx/html/

COPY src/nginx/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
