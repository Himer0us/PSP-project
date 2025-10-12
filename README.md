**Payment Processing Platform**

A Payment Service Provider with Stripe integration and real time statistics and analytics of payments.


**Description**

A Payment Service Provider which uses Stripe architecture to accept, refuse, cancel and refund payments, as well as storing payment history in MySQL and visualasing it in form of graph using Elastic search, Prometheus and Grafana. Can be used for online shopping, business-to-business payments and high-value transfers. 3D Secure Authentication is included.

**Prerequisites**

- Docker
- Stripe account

**Installing**

1. Clone the repository:
git clone https://github.com/Himer0us/boxopay-intern-project.git
cd boxopay-intern-project

2. Rename .env.example file into .env and change password and keys to your own keys.
Stripe keys can be taken from Stripe dashboard page when creating the sandbox

**Executing programme**

Start everything using command : docker-compose up --build -d
Backend will have 15 second delay to start up after starting the project

**Help**

Use: docker-compose ps  to check if everything is running

Frontend:	http://localhost	
Backend API:	http://localhost:3001	use http://localhost:3001/health to check if working
Grafana:	http://localhost:3002	(username: admin, password: admin)
Kibana:	http://localhost:5601	



